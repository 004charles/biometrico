import os
import asyncio
import secrets
from typing import Optional
from contextlib import asynccontextmanager
from fastapi import FastAPI, Form, File, UploadFile, HTTPException, Depends, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response

from .database import get_db, init_db
from .schemas import EmployeeResponse, AttendanceRecordResponse, DashboardStats
from .timeutil import APP_TIMEZONE, DB_TIME_FORMAT, now_local, today_local_str, parse_db_time, to_iso
from .humancore_sync import call_humancore, send_record, process_queue, queue_summary
from .reports import (resolve_period, period_bounds, fetch_punches, fetch_employees,
                      daily_summary, absent_on, build_csv, build_pdf)
from .face_service import face_service

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
EMP_PHOTOS_DIR = os.path.join(UPLOADS_DIR, "employees")
PUNCH_PHOTOS_DIR = os.path.join(UPLOADS_DIR, "punches")
for _d in (EMP_PHOTOS_DIR, PUNCH_PHOTOS_DIR):
    os.makedirs(_d, exist_ok=True)


def _save_photo(folder: str, image_bytes: bytes) -> str:
    """Guarda a foto com um nome aleatório e impossível de adivinhar (não inclui o código
    do colaborador, para a biometria não ficar identificável pelo nome do ficheiro)."""
    name = f"{secrets.token_urlsafe(16)}.jpg"
    with open(os.path.join(folder, name), "wb") as f:
        f.write(image_bytes)
    return os.path.relpath(os.path.join(folder, name), BASE_DIR)

# Senha de administração (cadastrar/remover caras). Guardada no servidor, não no app.
# Para trocar mais tarde: definir a variável de ambiente ADMIN_CODE com uma senha forte.
ADMIN_CODE = os.environ.get("ADMIN_CODE", "12345677654321")
if ADMIN_CODE == "12345677654321":
    print("⚠️  ATENÇÃO: a senha de administração ainda é a de defeito (pública). "
          "Antes de usar a sério, defina a variável ADMIN_CODE com uma senha forte.")


def require_admin(x_admin_code: str = Header(default="")):
    """Exige a senha de administração no cabeçalho X-Admin-Code."""
    if not secrets.compare_digest(str(x_admin_code or ""), ADMIN_CODE):
        raise HTTPException(status_code=401, detail="Senha de administração inválida.")
    return True


# Intervalo (segundos) da tarefa que reenvia as batidas pendentes ao Humancore. 0 = desligada.
SYNC_INTERVAL_SECONDS = int(os.environ.get("HUMANCORE_SYNC_INTERVAL", "60"))
# Tempo máximo de espera pelo Humancore no momento da batida (o resto fica para a fila)
PUNCH_SYNC_TIMEOUT = float(os.environ.get("HUMANCORE_PUNCH_TIMEOUT", "5"))

os.makedirs(STATIC_DIR, exist_ok=True)

# Inicializa banco
init_db()


async def _sync_worker():
    """Reenvia, em segundo plano, as batidas que ainda não chegaram ao Humancore."""
    while True:
        try:
            summary = await asyncio.to_thread(process_queue)
            if summary["sent_now"] or summary["failed_now"]:
                print(f"Fila Humancore: {summary['sent_now']} enviadas, {summary['failed_now']} falharam, "
                      f"{summary['pending'] + summary['error']} por enviar.")
        except Exception as e:
            print("Erro na fila de envio ao Humancore:", e)
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(_sync_worker()) if SYNC_INTERVAL_SECONDS > 0 else None
    yield
    if task:
        task.cancel()


app = FastAPI(
    title="Sistema de Ponto Biométrico Inteligente",
    description="API com Leitor de Impressão Digital e Dashboard Administrativa em Tempo Real",
    version="2.1.0",
    lifespan=lifespan,
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
               biometric_code, has_fingerprint, face_features, created_at
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
            tolerance_minutes=r["tolerance_minutes"] if r["tolerance_minutes"] is not None else 10,
            biometric_code=r["biometric_code"] or "",
            has_fingerprint=bool(r["has_fingerprint"]),
            has_face=bool(r["face_features"]),
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
        start_time = shift.get("start_time") or "08:00"
        if len(start_time) > 5:
            start_time = start_time[:5]
        tolerance = shift.get("late_tolerance_minutes")
        if tolerance is None:
            tolerance = 10
        
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

# Estado da fila de envio ao Humancore
@app.get("/api/humancore/sync-status")
def humancore_sync_status():
    return queue_summary()


# Enviar já as batidas pendentes ao Humancore (botão "Enviar ao Humancore")
@app.post("/api/humancore/sync-attendance")
async def sync_attendance_to_humancore():
    summary = await asyncio.to_thread(process_queue, True)
    remaining = summary["pending"] + summary["error"]
    if remaining == 0:
        msg = f"Tudo enviado! {summary['sent_now']} batida(s) enviada(s) agora; não há nada pendente."
    else:
        msg = (f"{summary['sent_now']} batida(s) enviada(s) agora. Ainda há {remaining} por enviar "
               f"(serão reenviadas automaticamente). Último erro: {summary['last_error']}")
    return {"success": remaining == 0, "message": msg, **summary}


# Fecho Diário de Ausências no Humancore
@app.post("/api/humancore/close-day")
async def close_day_humancore(force: bool = False):
    today_str = today_local_str()

    # Antes de lançar faltas, garante que todas as batidas de hoje chegaram ao Humancore;
    # caso contrário, quem picou o ponto poderia receber falta.
    await asyncio.to_thread(process_queue, True)
    today_q = queue_summary(day=today_str)
    unsent_today = today_q["pending"] + today_q["error"]
    if unsent_today and not force:
        return JSONResponse(status_code=409, content={
            "success": False,
            "unsent_today": unsent_today,
            "detail": (f"Há {unsent_today} batida(s) de hoje que ainda não chegaram ao Humancore. "
                       f"Se fechar o dia agora, esses funcionários podem receber falta. "
                       f"Último erro: {today_q['last_error']}"),
        })

    res = await asyncio.to_thread(call_humancore, "/integrations/biometric/attendance/close-day", "POST", {"date": today_str})
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
        created_at=now_local().strftime(DB_TIME_FORMAT)
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

# Hora oficial do servidor (usada pelos relógios do dashboard, totem e app)
@app.get("/api/time")
def server_time():
    now = now_local()
    return {
        "iso": to_iso(now),
        "epoch_ms": int(now.timestamp() * 1000),
        "timezone": str(APP_TIMEZONE),
        "utc_offset": now.strftime("%z"),
    }

# --- BATIDA DE PONTO POR IMPRESSÃO DIGITAL / CÓDIGO ---

# --- NÚCLEO PARTILHADO: registar uma batida (usado pela picagem por código e por cara) ---

async def _finalize_punch(db, employee, *, record_type="AUTO", fingerprint_verified=True,
                          face_verified=False, face_similarity=None, photo_path=None,
                          device_info="Terminal de Ponto"):
    """Grava a batida (anti-repetição, tipo, atraso), envia ao Humancore e devolve a resposta."""
    cursor = db.cursor()
    emp_id = employee["id"]
    emp_name = employee["name"]
    start_time_str = employee["work_start_time"] or "08:00"
    tolerance = employee["tolerance_minutes"] if employee["tolerance_minutes"] is not None else 10

    now_dt = now_local()
    now_str = now_dt.strftime(DB_TIME_FORMAT)
    today_str = now_dt.strftime("%Y-%m-%d")

    # Último ponto de hoje: anti-repetição e decisão entrada/saída
    cursor.execute("""
        SELECT timestamp, type FROM attendance
        WHERE employee_id = ? AND timestamp LIKE ?
        ORDER BY id DESC LIMIT 1
    """, (emp_id, f"{today_str}%"))
    last_punch = cursor.fetchone()

    if last_punch:
        try:
            diff_secs = (now_dt - parse_db_time(last_punch["timestamp"])).total_seconds()
            if diff_secs < 60:
                t_label = "Entrada" if last_punch["type"] == "CHECK_IN" else "Saída"
                return {
                    "success": True, "already_registered": True, "employee_name": emp_name,
                    "type_label": t_label, "timestamp": last_punch["timestamp"],
                    "message": f"Ponto de {t_label} já registado há {int(diff_secs)}s.",
                }
        except Exception:
            pass

    final_type = record_type
    if record_type == "AUTO":
        final_type = "CHECK_OUT" if (last_punch and last_punch["type"] == "CHECK_IN") else "CHECK_IN"

    delay_minutes, is_late = 0, 0
    if final_type == "CHECK_IN":
        try:
            expected_dt = parse_db_time(f"{today_str} {start_time_str[:5]}:00")
            diff_m = int((now_dt - expected_dt).total_seconds() // 60)
            if diff_m > tolerance:
                delay_minutes, is_late = diff_m, 1
        except Exception as e:
            print("Erro ao calcular atraso:", e)

    cursor.execute("""
        INSERT INTO attendance (
            employee_id, timestamp, type, fingerprint_verified, delay_minutes, is_late,
            device_info, status, sync_status, sync_attempts, face_verified, face_similarity, photo_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)
    """, (emp_id, now_str, final_type, 1 if fingerprint_verified else 0, delay_minutes, is_late,
          device_info, "APPROVED", 1 if face_verified else 0, face_similarity, photo_path))
    db.commit()
    record_id = cursor.lastrowid

    sync_status = "PENDING"
    try:
        sync = await asyncio.to_thread(send_record, record_id, PUNCH_SYNC_TIMEOUT)
        sync_status = sync["status"]
        if sync["late_minutes"] is not None:
            delay_minutes = sync["late_minutes"]
            is_late = 1 if delay_minutes > 0 else 0
    except Exception as e:
        print("Erro no envio imediato ao Humancore (fica na fila):", e)

    type_label = "Entrada" if final_type == "CHECK_IN" else "Saída"
    hora = now_str.split(" ")[1]
    if is_late:
        msg = f"Olá, {emp_name}! {type_label} registada às {hora} com {delay_minutes} min de atraso."
    else:
        msg = f"Olá, {emp_name}! {type_label} registada com sucesso às {hora} no horário previsto."

    return {
        "success": True, "record_id": record_id, "employee_name": emp_name,
        "employee_code": employee["code"], "department": employee["department"],
        "type": final_type, "type_label": type_label, "timestamp": now_str,
        "delay_minutes": delay_minutes, "is_late": bool(is_late),
        "face_similarity": round(face_similarity, 3) if face_similarity is not None else None,
        "humancore_sync": sync_status, "message": msg,
    }


def _find_employee(cursor, code_clean):
    cursor.execute("""
        SELECT id, code, name, department, role, work_start_time, tolerance_minutes,
               biometric_code, has_fingerprint, face_features
        FROM employees WHERE code = ? OR biometric_code = ?
    """, (code_clean, code_clean))
    return cursor.fetchone()


# --- BATIDA POR CÓDIGO / IMPRESSÃO DIGITAL (compatibilidade) ---

@app.post("/api/attendance/punch")
async def punch_attendance(request: Request, db = Depends(get_db)):
    employee_code, record_type, fingerprint_verified = "", "AUTO", True
    device_info = "Terminal de Ponto Biométrico"

    if "application/json" in request.headers.get("content-type", ""):
        try:
            body = await request.json()
            employee_code = str(body.get("employee_code", ""))
            record_type = str(body.get("record_type", "AUTO"))
            fingerprint_verified = bool(body.get("fingerprint_verified", True))
            device_info = str(body.get("device_info", device_info))
        except Exception:
            pass
    else:
        try:
            form = await request.form()
            employee_code = str(form.get("employee_code", ""))
            record_type = str(form.get("record_type", "AUTO"))
            fingerprint_verified = str(form.get("fingerprint_verified", "true")).lower() in ("true", "1")
            device_info = str(form.get("device_info", device_info))
        except Exception:
            pass

    code_clean = employee_code.strip().upper()
    cursor = db.cursor()

    if code_clean == "BIO_DIRECT":
        cursor.execute("""SELECT id, code, name, department, role, work_start_time, tolerance_minutes,
                          biometric_code, has_fingerprint, face_features FROM employees WHERE has_fingerprint = 1""")
        all_emps = cursor.fetchall()
        if len(all_emps) == 1:
            employee = all_emps[0]
        else:
            return JSONResponse(status_code=404, content={"success": False, "message": "Usuário não encontrado"})
    else:
        employee = _find_employee(cursor, code_clean)

    if not employee or not employee["has_fingerprint"]:
        return JSONResponse(status_code=404, content={"success": False, "message": "Usuário não encontrado"})

    return await _finalize_punch(db, employee, record_type=record_type,
                                 fingerprint_verified=fingerprint_verified, device_info=device_info)


# --- CADASTRO DA CARA DE UM COLABORADOR ---

@app.post("/api/employees/{emp_id}/enroll-face")
async def enroll_face(emp_id: int, photo: UploadFile = File(...), db = Depends(get_db),
                      _admin: bool = Depends(require_admin)):
    cursor = db.cursor()
    cursor.execute("SELECT id, code, name FROM employees WHERE id = ?", (emp_id,))
    emp = cursor.fetchone()
    if not emp:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado.")

    data = await photo.read()
    feature, err = await asyncio.to_thread(face_service.features_from_bytes, data)
    if err:
        return JSONResponse(status_code=422, content={"success": False, "message": err})

    photo_path = _save_photo(EMP_PHOTOS_DIR, data)
    cursor.execute("UPDATE employees SET face_features = ?, photo_path = ? WHERE id = ?",
                   (face_service.to_blob(feature), photo_path, emp_id))
    db.commit()
    return {"success": True, "message": f"Rosto de {emp['name']} cadastrado com sucesso!",
            "photo_url": "/" + photo_path.replace(os.sep, "/")}


@app.delete("/api/employees/{emp_id}/face")
def delete_face(emp_id: int, db = Depends(get_db), _admin: bool = Depends(require_admin)):
    cursor = db.cursor()
    cursor.execute("UPDATE employees SET face_features = NULL WHERE id = ?", (emp_id,))
    db.commit()
    return {"success": True, "message": "Cadastro facial removido."}


# --- BATIDA POR CÓDIGO + CARA (reconhecimento facial 1:1) ---

@app.post("/api/attendance/punch-face")
async def punch_face(
    employee_code: str = Form(...),
    photo: UploadFile = File(...),
    record_type: str = Form("AUTO"),
    device_info: str = Form("Terminal Facial (Entrada)"),
    db = Depends(get_db),
):
    code_clean = employee_code.strip().upper()
    cursor = db.cursor()
    employee = _find_employee(cursor, code_clean)
    if not employee:
        return JSONResponse(status_code=404, content={
            "success": False, "reason": "not_found",
            "message": "Código não encontrado. Verifique o número que digitou."})
    if not employee["face_features"]:
        return JSONResponse(status_code=404, content={
            "success": False, "reason": "no_face",
            "message": f"{employee['name']} ainda não tem rosto cadastrado. Procure o RH."})

    data = await photo.read()
    ok, score, err = await asyncio.to_thread(face_service.verify, data, employee["face_features"])
    if not ok:
        return JSONResponse(status_code=200, content={
            "success": False, "reason": "no_match", "face_similarity": round(score, 3),
            "employee_name": employee["name"], "message": err})

    photo_path = _save_photo(PUNCH_PHOTOS_DIR, data)
    return await _finalize_punch(db, employee, record_type=record_type, fingerprint_verified=False,
                                 face_verified=True, face_similarity=score, photo_path=photo_path,
                                 device_info=device_info)


# --- REGISTROS DE PRESENÇA ---
# Todos os filtros aceitam: ?date=AAAA-MM-DD  |  ?month=AAAA-MM  |  ?date_from=...&date_to=...
# Sem filtro = HOJE.

@app.get("/api/attendance/records", response_model=list[AttendanceRecordResponse])
def get_attendance_records(
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    month: Optional[str] = None,
    limit: int = 2000,
    db = Depends(get_db),
):
    start, end = resolve_period(date, date_from, date_to, month)
    lo, hi = period_bounds(start, end)
    cursor = db.cursor()
    cursor.execute("""
        SELECT a.id, a.employee_id, e.name as employee_name, e.code as employee_code,
               e.department, a.timestamp, a.type, a.fingerprint_verified,
               a.delay_minutes, a.is_late, a.device_info, a.status,
               a.sync_status, a.sync_error, a.sync_attempts
        FROM attendance a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.timestamp >= ? AND a.timestamp < ?
        ORDER BY a.timestamp DESC, a.id DESC
        LIMIT ?
    """, (lo, hi, max(1, min(limit, 10000))))
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
            status=r["status"],
            sync_status=r["sync_status"] or "SENT",
            sync_error=r["sync_error"],
            sync_attempts=int(r["sync_attempts"] or 0)
        )
        for r in rows
    ]


# Resumo por colaborador e por dia (entrada, saída, horas trabalhadas, atraso)
@app.get("/api/attendance/daily-summary")
def get_daily_summary(
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    month: Optional[str] = None,
    db = Depends(get_db),
):
    start, end = resolve_period(date, date_from, date_to, month)
    summary = daily_summary(fetch_punches(db, start, end))
    return {"date_from": f"{start:%Y-%m-%d}", "date_to": f"{end:%Y-%m-%d}", "rows": summary}


# Colaboradores sem nenhuma batida num dia
@app.get("/api/attendance/absent")
def get_absent(date: Optional[str] = None, db = Depends(get_db)):
    day, _ = resolve_period(date)
    summary = daily_summary(fetch_punches(db, day, day))
    return absent_on(fetch_employees(db), summary, f"{day:%Y-%m-%d}")


# --- ESTATÍSTICAS DA DASHBOARD ADMINISTRATIVA ---

@app.get("/api/dashboard/stats", response_model=DashboardStats)
def get_dashboard_stats(date: Optional[str] = None, db = Depends(get_db)):
    day, _ = resolve_period(date)
    lo, hi = period_bounds(day, day)
    cursor = db.cursor()

    cursor.execute("SELECT COUNT(*) FROM employees")
    total_emp = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM attendance WHERE timestamp >= ? AND timestamp < ?", (lo, hi))
    day_punches = cursor.fetchone()[0]

    # Presentes: pelo menos uma entrada no dia
    cursor.execute("""
        SELECT COUNT(DISTINCT employee_id) FROM attendance
        WHERE timestamp >= ? AND timestamp < ? AND type = 'CHECK_IN' AND status = 'APPROVED'
    """, (lo, hi))
    present = cursor.fetchone()[0]

    # Sem registo: colaboradores sem nenhuma entrada no dia
    absent = max(0, total_emp - present)

    cursor.execute("""
        SELECT COUNT(DISTINCT employee_id) FROM attendance
        WHERE timestamp >= ? AND timestamp < ? AND is_late = 1
    """, (lo, hi))
    late = cursor.fetchone()[0]

    cursor.execute("""
        SELECT COALESCE(SUM(delay_minutes), 0) FROM attendance
        WHERE timestamp >= ? AND timestamp < ? AND is_late = 1
    """, (lo, hi))
    total_delay_minutes = cursor.fetchone()[0]

    records = get_attendance_records(date=f"{day:%Y-%m-%d}", limit=20, db=db)
    sync_q = queue_summary()

    return DashboardStats(
        date=f"{day:%Y-%m-%d}",
        is_today=f"{day:%Y-%m-%d}" == today_local_str(),
        total_employees=total_emp,
        present_today=present,
        absent_today=absent,
        late_today=late,
        total_delay_minutes=total_delay_minutes,
        today_punches=day_punches,
        recent_records=records,
        sync_pending=sync_q["pending"],
        sync_errors=sync_q["error"],
        sync_last_error=sync_q["last_error"]
    )


# --- EXPORTAÇÃO DE RELATÓRIOS (CSV / PDF) ---

def _export_filename(start, end, ext):
    if start == end:
        return f"relatorio_ponto_{start:%Y-%m-%d}.{ext}"
    return f"relatorio_ponto_{start:%Y-%m-%d}_a_{end:%Y-%m-%d}.{ext}"


@app.get("/api/attendance/export/csv")
def export_attendance_csv(
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    month: Optional[str] = None,
    db = Depends(get_db),
):
    start, end = resolve_period(date, date_from, date_to, month)
    content = build_csv(fetch_punches(db, start, end))
    return Response(
        content=content.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{_export_filename(start, end, "csv")}"'}
    )


@app.get("/api/attendance/export/pdf")
def export_attendance_pdf(
    date: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    month: Optional[str] = None,
    db = Depends(get_db),
):
    start, end = resolve_period(date, date_from, date_to, month)
    pdf = build_pdf(start, end, fetch_employees(db), fetch_punches(db, start, end))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{_export_filename(start, end, "pdf")}"'}
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

app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
