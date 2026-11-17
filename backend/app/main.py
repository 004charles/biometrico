import os
import datetime
import csv
import io
import json
import urllib.request
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response

from .database import get_db, init_db
from .schemas import EmployeeResponse, AttendanceRecordResponse, DashboardStats

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

# Humancore HRMS Integration Config
HUMANCORE_URL = os.environ.get("HUMANCORE_URL", "http://127.0.0.1:5173/api/v1")
HUMANCORE_TOKEN = os.environ.get("HUMANCORE_TOKEN", "30|xG7uKPHrjRZuriX39hCFq0Q25KKN9OWYTkE2maIN37f70bf2")
HUMANCORE_TENANT_ID = os.environ.get("HUMANCORE_TENANT_ID", "8")

def call_humancore(path: str, method: str = "GET", data: dict = None):
    url = f"{HUMANCORE_URL}{path}"
    headers = {
        "Authorization": f"Bearer {HUMANCORE_TOKEN}",
        "X-Tenant-ID": str(HUMANCORE_TENANT_ID),
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Erro ao comunicar com Humancore [{method} {path}]:", e)
        return None

os.makedirs(STATIC_DIR, exist_ok=True)

# Inicializa banco
init_db()

app = FastAPI(
    title="Sistema de Ponto Biométrico Inteligente",
    description="API com Leitor de Impressão Digital e Dashboard Administrativa em Tempo Real",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- ROTAS DE COLABORADORES ---

@app.get("/api/employees", response_model=list[EmployeeResponse])
def list_employees(db = Depends(get_db)):
    cursor = db.cursor()
    cursor.execute("""
        SELECT id, code, name, department, role, work_start_time, tolerance_minutes, 
               biometric_code, has_fingerprint, created_at 
        FROM employees 
        ORDER BY name ASC
    """)
    rows = cursor.fetchall()
    return [
        EmployeeResponse(
            id=r["id"],
            code=r["code"],
            name=r["name"],
            department=r["department"],
            role=r["role"],
            work_start_time=r["work_start_time"] or "08:00",
            tolerance_minutes=r["tolerance_minutes"] or 10,
            biometric_code=r["biometric_code"] or "",
            has_fingerprint=bool(r["has_fingerprint"]),
            created_at=str(r["created_at"])
        )
        for r in rows
    ]

# Sincronizar Colaboradores do Humancore HRMS
@app.post("/api/humancore/sync")
@app.get("/api/humancore/sync")
def sync_from_humancore(db = Depends(get_db)):
    res = call_humancore("/integrations/biometric/employees?all=1")
    if not res or not res.get("success"):
        raise HTTPException(status_code=502, detail="Não foi possível sincronizar com o Humancore.")
    
    data = res.get("data", {})
    employees = data.get("employees", [])
    cursor = db.cursor()
    imported = 0

    for idx, emp in enumerate(employees, start=101):
        emp_code = emp.get("employee_code") or f"EMP-{emp.get('id')}"
        name = emp.get("full_name") or f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip()
        dept = emp.get("department") or "Geral"
        pos = emp.get("position") or "Colaborador"
        shift = emp.get("shift") or {}
        start_time = shift.get("start_time", "08:00")
        if len(start_time) > 5:
            start_time = start_time[:5]
        tolerance = shift.get("late_tolerance_minutes", 10)
        
        bio_code = emp.get("biometric_code")
        if not bio_code or bio_code == emp_code:
            bio_code = str(idx)

        cursor.execute("SELECT id, biometric_code, has_fingerprint FROM employees WHERE code = ?", (emp_code,))
        existing = cursor.fetchone()
        if existing:
            cursor.execute("""
                UPDATE employees 
                SET name = ?, department = ?, role = ?, work_start_time = ?, tolerance_minutes = ?, humancore_id = ?
                WHERE id = ?
            """, (name, dept, pos, start_time, tolerance, emp.get("id"), existing["id"]))
        else:
            cursor.execute("""
                INSERT INTO employees (code, name, department, role, work_start_time, tolerance_minutes, biometric_code, has_fingerprint, humancore_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
            """, (emp_code, name, dept, pos, start_time, tolerance, bio_code, emp.get("id")))
            imported += 1

    db.commit()
    return {
        "success": True,
        "total_humancore": len(employees),
        "imported": imported,
        "message": f"{len(employees)} colaboradores sincronizados com sucesso do Humancore!"
    }

# Cadastro Biométrico (Após os 3 toques do dedo no tablet)
@app.post("/api/employees/{emp_id}/enroll-fingerprint")
async def enroll_employee_fingerprint(emp_id: int, request: Request, db = Depends(get_db)):
    biometric_code = None
    try:
        body = await request.json()
        biometric_code = body.get("biometric_code")
    except Exception:
        pass
    
    cursor = db.cursor()
    cursor.execute("SELECT id, code, name, biometric_code FROM employees WHERE id = ?", (emp_id,))
    emp = cursor.fetchone()
    if not emp:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado.")

    final_bio_code = str(biometric_code or emp["biometric_code"] or emp["code"]).strip()

    # Grava digital como ativa
    cursor.execute("""
        UPDATE employees 
        SET has_fingerprint = 1, biometric_code = ?
        WHERE id = ?
    """, (final_bio_code, emp_id))
    db.commit()

    # Sincroniza o vínculo no Humancore
    sync_payload = {
        "employees": [
            {
                "employee_code": emp["code"],
                "biometric_code": final_bio_code
            }
        ]
    }
    humancore_res = call_humancore("/integrations/biometric/employees/sync", method="POST", data=sync_payload)

    return {
        "success": True,
        "message": f"Impressão digital de {emp['name']} cadastrada com sucesso!",
        "biometric_code": final_bio_code,
        "humancore_synced": bool(humancore_res and humancore_res.get("success"))
    }

# Envio de Marcações Diárias em Lote para o Humancore
@app.post("/api/humancore/sync-attendance")
def sync_attendance_to_humancore(db = Depends(get_db)):
    cursor = db.cursor()
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT a.id, a.timestamp, a.type, e.code, e.biometric_code, a.device_info 
        FROM attendance a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.timestamp LIKE ?
        ORDER BY a.id ASC
    """, (f"{today_str}%",))
    rows = cursor.fetchall()

    if not rows:
        return {"success": True, "message": "Nenhum ponto registrado hoje para sincronizar.", "processed": 0}

    punches = []
    for r in rows:
        bio_code = r["biometric_code"] or r["code"]
        try:
            dt = datetime.datetime.strptime(r["timestamp"], "%Y-%m-%d %H:%M:%S")
            iso_time = dt.strftime("%Y-%m-%dT%H:%M:%S+01:00")
        except Exception:
            iso_time = r["timestamp"]

        direction = "in" if r["type"] == "CHECK_IN" else ("out" if r["type"] == "CHECK_OUT" else "auto")
        punches.append({
            "biometric_code": str(bio_code),
            "punched_at": iso_time,
            "direction": direction
        })

    payload = {
        "device_name": "Tablet Entrada SCKJ",
        "debounce_seconds": 60,
        "punches": punches
    }

    res = call_humancore("/integrations/biometric/attendance", method="POST", data=payload)
    if not res or not res.get("success"):
        raise HTTPException(status_code=502, detail="Erro ao sincronizar presenças com o Humancore.")

    data = res.get("data", {})
    return {
        "success": True,
        "processed": data.get("processed", len(punches)),
        "created": data.get("created", 0),
        "updated": data.get("updated", 0),
        "ignored_duplicates": data.get("ignored_duplicates", 0),
        "message": f"Sincronização concluída: {data.get('processed', len(punches))} marcações enviadas com sucesso ao Humancore!"
    }

# Fecho Diário de Ausências no Humancore
@app.post("/api/humancore/close-day")
def close_day_humancore():
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    payload = {"date": today_str}
    res = call_humancore("/integrations/biometric/attendance/close-day", method="POST", data=payload)
    if not res or not res.get("success"):
        raise HTTPException(status_code=502, detail="Erro ao realizar fecho diário no Humancore.")

    data = res.get("data", {})
    return {
        "success": True,
        "marked_absent_count": data.get("marked_absent_count", 0),
        "skipped_existing_count": data.get("skipped_existing_count", 0),
        "message": f"Fecho diário concluído! {data.get('marked_absent_count', 0)} faltas lançadas automaticamente no Humancore."
    }

@app.post("/api/employees", response_model=EmployeeResponse)
def create_employee(
    code: str = Form(...),
    name: str = Form(...),
    department: str = Form(...),
    role: str = Form(...),
    work_start_time: str = Form("08:00"),
    tolerance_minutes: int = Form(10),
    db = Depends(get_db)
):
    code_clean = code.strip().upper()
    cursor = db.cursor()
    cursor.execute("SELECT id FROM employees WHERE code = ?", (code_clean,))
    if cursor.fetchone():
        raise HTTPException(status_code=400, detail="Código de funcionário já cadastrado.")

    cursor.execute("""
        INSERT INTO employees (code, name, department, role, work_start_time, tolerance_minutes)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (code_clean, name.strip(), department.strip(), role.strip(), work_start_time.strip(), tolerance_minutes))
    db.commit()
    emp_id = cursor.lastrowid

    return EmployeeResponse(
        id=emp_id,
        code=code_clean,
        name=name.strip(),
        department=department.strip(),
        role=role.strip(),
        work_start_time=work_start_time.strip(),
        tolerance_minutes=tolerance_minutes,
        created_at=datetime.datetime.now().isoformat()
    )

@app.delete("/api/employees/{emp_id}")
def delete_employee(emp_id: int, db = Depends(get_db)):
    cursor = db.cursor()
    cursor.execute("SELECT id, name FROM employees WHERE id = ?", (emp_id,))
    emp = cursor.fetchone()
    if not emp:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado.")
    
    cursor.execute("DELETE FROM attendance WHERE employee_id = ?", (emp_id,))
    cursor.execute("DELETE FROM employees WHERE id = ?", (emp_id,))
    db.commit()
    return {"success": True, "message": f"Colaborador {emp['name']} excluído com sucesso."}


@app.get("/api/health")
@app.head("/api/health")
@app.head("/")
def health_check():
    return {"status": "ok"}

# --- BATIDA DE PONTO POR IMPRESSÃO DIGITAL / CÓDIGO ---

@app.post("/api/attendance/punch")
async def punch_attendance(
    request: Request,
    db = Depends(get_db)
):
    employee_code = ""
    record_type = "AUTO"
    fingerprint_verified = True
    device_info = "Terminal de Ponto Biométrico"

    c_type = request.headers.get("content-type", "")
    if "application/json" in c_type:
        try:
            body = await request.json()
            employee_code = str(body.get("employee_code", ""))
            record_type = str(body.get("record_type", "AUTO"))
            fingerprint_verified = bool(body.get("fingerprint_verified", True))
            device_info = str(body.get("device_info", "Terminal de Ponto Biométrico"))
        except Exception:
            pass
    else:
        try:
            form = await request.form()
            employee_code = str(form.get("employee_code", ""))
            record_type = str(form.get("record_type", "AUTO"))
            raw_fp = str(form.get("fingerprint_verified", "true")).lower()
            fingerprint_verified = raw_fp in ("true", "1")
            device_info = str(form.get("device_info", "Terminal de Ponto Biométrico"))
        except Exception:
            pass

    code_clean = employee_code.strip().upper()
    cursor = db.cursor()

    if code_clean == "BIO_DIRECT":
        cursor.execute("SELECT id, code, name, department, role, work_start_time, tolerance_minutes, biometric_code, has_fingerprint FROM employees WHERE has_fingerprint = 1")
        all_emps = cursor.fetchall()
        if len(all_emps) == 1:
            employee = all_emps[0]
            code_clean = employee["code"]
        else:
            return JSONResponse(status_code=404, content={
                "success": False,
                "message": "Usuário não encontrado"
            })
    else:
        cursor.execute("""
            SELECT id, code, name, department, role, work_start_time, tolerance_minutes, biometric_code, has_fingerprint 
            FROM employees 
            WHERE code = ? OR biometric_code = ?
        """, (code_clean, code_clean))
        employee = cursor.fetchone()

    # Se o funcionário não estiver cadastrado no sistema
    if not employee:
        return JSONResponse(status_code=404, content={
            "success": False,
            "message": "Usuário não encontrado"
        })

    # Se o colaborador não cadastrou a impressão digital ainda
    if not employee["has_fingerprint"]:
        return JSONResponse(status_code=404, content={
            "success": False,
            "message": "Usuário não encontrado"
        })

    emp_id = employee["id"]
    emp_name = employee["name"]
    start_time_str = employee["work_start_time"] or "08:00"
    tolerance = employee["tolerance_minutes"] or 10

    now_dt = datetime.datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    today_str = now_dt.strftime("%Y-%m-%d")

    # Verificar último ponto do dia para anti-spam e definição de entrada/saída
    cursor.execute("""
        SELECT timestamp, type FROM attendance 
        WHERE employee_id = ? AND timestamp LIKE ? 
        ORDER BY id DESC LIMIT 1
    """, (emp_id, f"{today_str}%"))
    last_punch = cursor.fetchone()

    if last_punch:
        try:
            last_dt = datetime.datetime.strptime(last_punch["timestamp"], "%Y-%m-%d %H:%M:%S")
            diff_secs = (now_dt - last_dt).total_seconds()
            if diff_secs < 60:
                t_label = "Entrada" if last_punch["type"] == "CHECK_IN" else "Saída"
                return JSONResponse(status_code=200, content={
                    "success": True,
                    "already_registered": True,
                    "employee_name": emp_name,
                    "type_label": t_label,
                    "timestamp": last_punch["timestamp"],
                    "message": f"Ponto de {t_label} já registrado há {int(diff_secs)}s."
                })
        except Exception:
            pass

    # Determinar tipo se for AUTO
    final_type = record_type
    if record_type == "AUTO":
        if last_punch and last_punch["type"] == "CHECK_IN":
            final_type = "CHECK_OUT"
        else:
            final_type = "CHECK_IN"

    # Cálculo dos minutos de atraso (apenas para Entrada)
    delay_minutes = 0
    is_late = 0
    if final_type == "CHECK_IN":
        try:
            expected_dt = datetime.datetime.strptime(f"{today_str} {start_time_str}:00", "%Y-%m-%d %H:%M:%S")
            diff_m = int((now_dt - expected_dt).total_seconds() / 60)
            if diff_m > tolerance:
                delay_minutes = diff_m
                is_late = 1
        except Exception as e:
            print("Erro ao calcular atraso:", e)

    cursor.execute("""
        INSERT INTO attendance (
            employee_id, timestamp, type, fingerprint_verified, 
            delay_minutes, is_late, device_info, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        emp_id, now_str, final_type, 1 if fingerprint_verified else 0,
        delay_minutes, is_late, device_info, "APPROVED"
    ))
    db.commit()
    record_id = cursor.lastrowid

    # Sincronização em tempo real com o Humancore HRMS
    try:
        hc_payload = {
            "biometric_code": employee["biometric_code"] or employee["code"],
            "punched_at": now_dt.strftime("%Y-%m-%dT%H:%M:%S+01:00"),
            "device_name": device_info or "Tablet Entrada SCKJ"
        }
        hc_res = call_humancore("/integrations/biometric/attendance", method="POST", data=hc_payload)
        if hc_res and hc_res.get("success"):
            results = hc_res.get("data", {}).get("results", [])
            if results:
                first = results[0]
                if first.get("late_minutes") is not None:
                    delay_minutes = first["late_minutes"]
                    is_late = 1 if delay_minutes > 0 else 0
                    cursor.execute("UPDATE attendance SET delay_minutes = ?, is_late = ? WHERE id = ?", (delay_minutes, is_late, record_id))
                    db.commit()
    except Exception as e:
        print("Erro sync Humancore attendance:", e)

    type_label = "Entrada" if final_type == "CHECK_IN" else "Saída"
    if is_late:
        msg = f"Olá, {emp_name}! {type_label} registrada às {now_str.split(' ')[1]} com {delay_minutes} min de atraso."
    else:
        msg = f"Olá, {emp_name}! {type_label} registrada com sucesso às {now_str.split(' ')[1]} no horário previsto."

    return {
        "success": True,
        "record_id": record_id,
        "employee_name": emp_name,
        "employee_code": code_clean,
        "department": employee["department"],
        "type": final_type,
        "type_label": type_label,
        "timestamp": now_str,
        "delay_minutes": delay_minutes,
        "is_late": bool(is_late),
        "message": msg
    }


# --- REGISTROS DE PRESENÇA ---

@app.get("/api/attendance/records", response_model=list[AttendanceRecordResponse])
def get_attendance_records(limit: int = 100, db = Depends(get_db)):
    cursor = db.cursor()
    cursor.execute("""
        SELECT a.id, a.employee_id, e.name as employee_name, e.code as employee_code,
               e.department, a.timestamp, a.type, a.fingerprint_verified, 
               a.delay_minutes, a.is_late, a.device_info, a.status
        FROM attendance a
        JOIN employees e ON a.employee_id = e.id
        ORDER BY a.id DESC
        LIMIT ?
    """, (limit,))
    rows = cursor.fetchall()
    return [
        AttendanceRecordResponse(
            id=r["id"],
            employee_id=r["employee_id"],
            employee_name=r["employee_name"],
            employee_code=r["employee_code"],
            department=r["department"],
            timestamp=str(r["timestamp"]),
            type=r["type"],
            fingerprint_verified=bool(r["fingerprint_verified"]),
            delay_minutes=int(r["delay_minutes"] or 0),
            is_late=bool(r["is_late"]),
            device_info=r["device_info"],
            status=r["status"]
        )
        for r in rows
    ]


# --- ESTATÍSTICAS DA DASHBOARD ADMINISTRATIVA (BRANCA) ---

@app.get("/api/dashboard/stats", response_model=DashboardStats)
def get_dashboard_stats(db = Depends(get_db)):
    cursor = db.cursor()
    
    # 1. Total de Colaboradores
    cursor.execute("SELECT COUNT(*) FROM employees")
    total_emp = cursor.fetchone()[0]

    today_str = datetime.date.today().strftime("%Y-%m-%d")

    # 2. Total de Batidas Hoje
    cursor.execute("SELECT COUNT(*) FROM attendance WHERE timestamp LIKE ?", (f"{today_str}%",))
    today_punches = cursor.fetchone()[0]

    # 3. Quantos estão PRESENTES hoje (bateram ao menos um CHECK_IN hoje)
    cursor.execute("""
        SELECT COUNT(DISTINCT employee_id) FROM attendance 
        WHERE timestamp LIKE ? AND type = 'CHECK_IN' AND status = 'APPROVED'
    """, (f"{today_str}%",))
    present_today = cursor.fetchone()[0]

    # 4. Quantos FALTARAM hoje (total de colaboradores cadastrados menos os presentes)
    absent_today = max(0, total_emp - present_today)

    # 5. Quantos chegaram ATRASADOS hoje
    cursor.execute("""
        SELECT COUNT(DISTINCT employee_id) FROM attendance 
        WHERE timestamp LIKE ? AND is_late = 1
    """, (f"{today_str}%",))
    late_today = cursor.fetchone()[0]

    # 6. Total de MINUTOS DE ATRASO acumulados hoje
    cursor.execute("""
        SELECT COALESCE(SUM(delay_minutes), 0) FROM attendance 
        WHERE timestamp LIKE ? AND is_late = 1
    """, (f"{today_str}%",))
    total_delay_minutes = cursor.fetchone()[0]

    records = get_attendance_records(limit=20, db=db)

    return DashboardStats(
        total_employees=total_emp,
        present_today=present_today,
        absent_today=absent_today,
        late_today=late_today,
        total_delay_minutes=total_delay_minutes,
        today_punches=today_punches,
        recent_records=records
    )


# --- EXPORTAÇÃO CSV DE RELATÓRIO ---

@app.get("/api/attendance/export/csv")
def export_attendance_csv(db = Depends(get_db)):
    cursor = db.cursor()
    cursor.execute("""
        SELECT a.id, e.code, e.name, e.department, e.role, e.work_start_time,
               a.timestamp, a.type, a.is_late, a.delay_minutes, a.status, a.device_info
        FROM attendance a
        JOIN employees e ON a.employee_id = e.id
        ORDER BY a.id DESC
    """)
    rows = cursor.fetchall()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow([
        "ID", "Código", "Nome", "Departamento", "Cargo", "Horário Previsto", 
        "Data e Hora Ponto", "Tipo", "Atrasado?", "Minutos de Atraso", "Status", "Dispositivo"
    ])

    for r in rows:
        tipo = "Entrada" if r["type"] == "CHECK_IN" else "Saída"
        atrasado = "SIM" if r["is_late"] else "NÃO"
        minutos = f"{r['delay_minutes']} min" if r["delay_minutes"] else "0 min"
        writer.writerow([
            r["id"], r["code"], r["name"], r["department"], r["role"], r["work_start_time"],
            r["timestamp"], tipo, atrasado, minutos, r["status"], r["device_info"] or "Terminal"
        ])

    csv_data = output.getvalue()
    today_str = datetime.date.today().strftime("%Y%m%d")
    filename = f"relatorio_pontos_{today_str}.csv"

    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# --- ROTAS DE TELAS (DASHBOARD E TOTEM PWA) ---

@app.get("/totem")
def serve_totem():
    totem_path = os.path.join(STATIC_DIR, "totem.html")
    if os.path.exists(totem_path):
        return FileResponse(totem_path)
    return {"message": "Totem sendo configurado..."}

@app.get("/manifest.json")
def serve_manifest():
    manifest_path = os.path.join(STATIC_DIR, "manifest.json")
    return FileResponse(manifest_path, media_type="application/manifest+json")

@app.get("/download/app.apk")
@app.get("/app.apk")
def download_apk():
    # Procura na pasta static ou pasta raiz do backend/mobile
    candidates = [
        os.path.join(STATIC_DIR, "app-ponto.apk"),
        os.path.join(BASE_DIR, "app-release.apk"),
        os.path.join(os.path.dirname(BASE_DIR), "mobile/android/app/build/outputs/apk/release/app-release.apk")
    ]
    for p in candidates:
        if os.path.exists(p):
            return FileResponse(
                p,
                media_type="application/vnd.android.package-archive",
                filename="ponto-biometrico.apk"
            )
    raise HTTPException(status_code=404, detail="APK ainda não compilado.")

@app.get("/")
def serve_dashboard():
    dashboard_index = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(dashboard_index):
        return FileResponse(dashboard_index)
    return {"message": "Dashboard no ar!"}

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
