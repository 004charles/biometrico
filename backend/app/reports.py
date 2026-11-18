"""Relatórios de assiduidade: filtros por período, resumo diário e exportação (PDF/CSV)."""
import csv
import datetime
import io
from collections import OrderedDict
from xml.sax.saxutils import escape as xml_escape

from fastapi import HTTPException

from .timeutil import now_local, today_local_str

MAX_RANGE_DAYS = 366
DATE_FMT = "%Y-%m-%d"


# ---------------------------------------------------------------- períodos

def _parse_date(value: str, field: str) -> datetime.date:
    try:
        return datetime.datetime.strptime(value, DATE_FMT).date()
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"Data inválida em '{field}': use o formato AAAA-MM-DD.")


def resolve_period(date: str = None, date_from: str = None, date_to: str = None, month: str = None):
    """Devolve (inicio, fim) como datas. Prioridade: month > date_from/date_to > date > hoje."""
    if month:
        try:
            first = datetime.datetime.strptime(month, "%Y-%m").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Mês inválido: use o formato AAAA-MM.")
        next_month = (first.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
        return first, next_month - datetime.timedelta(days=1)

    if date_from or date_to:
        start = _parse_date(date_from or date_to, "date_from")
        end = _parse_date(date_to or date_from, "date_to")
        if end < start:
            raise HTTPException(status_code=400, detail="A data final é anterior à data inicial.")
        if (end - start).days >= MAX_RANGE_DAYS:
            raise HTTPException(status_code=400, detail=f"O período máximo é de {MAX_RANGE_DAYS} dias.")
        return start, end

    day = _parse_date(date, "date") if date else _parse_date(today_local_str(), "date")
    return day, day


def period_bounds(start: datetime.date, end: datetime.date):
    """Limites para comparar com a coluna timestamp ('AAAA-MM-DD HH:MM:SS')."""
    return f"{start:%Y-%m-%d} 00:00:00", f"{end + datetime.timedelta(days=1):%Y-%m-%d} 00:00:00"


def period_label(start: datetime.date, end: datetime.date) -> str:
    if start == end:
        return start.strftime("%d/%m/%Y")
    return f"{start:%d/%m/%Y} a {end:%d/%m/%Y}"


# ---------------------------------------------------------------- dados

def fetch_punches(conn, start, end):
    lo, hi = period_bounds(start, end)
    return conn.execute("""
        SELECT a.id, a.employee_id, a.timestamp, a.type, a.delay_minutes, a.is_late,
               a.device_info, a.status, a.sync_status,
               e.code, e.name, e.department, e.role, e.work_start_time
        FROM attendance a
        JOIN employees e ON e.id = a.employee_id
        WHERE a.timestamp >= ? AND a.timestamp < ?
        ORDER BY a.timestamp ASC, a.id ASC
    """, (lo, hi)).fetchall()


def fetch_employees(conn):
    return conn.execute("""
        SELECT id, code, name, department, role, work_start_time, has_fingerprint
        FROM employees ORDER BY name ASC
    """).fetchall()


def _minutes_between(a: str, b: str) -> int:
    fmt = "%Y-%m-%d %H:%M:%S"
    delta = datetime.datetime.strptime(b, fmt) - datetime.datetime.strptime(a, fmt)
    return max(0, int(delta.total_seconds() // 60))


def daily_summary(punches):
    """Uma linha por colaborador por dia: entrada, saída, horas trabalhadas e atraso."""
    groups = OrderedDict()
    for p in punches:
        key = (p["timestamp"][:10], p["employee_id"])
        groups.setdefault(key, []).append(p)

    rows = []
    for (day, emp_id), items in groups.items():
        first = items[0]
        check_ins = [p for p in items if p["type"] == "CHECK_IN"]
        check_outs = [p for p in items if p["type"] == "CHECK_OUT"]

        # Soma dos pares Entrada -> Saída (permite várias entradas/saídas no dia)
        worked = 0
        open_in = None
        for p in items:
            if p["type"] == "CHECK_IN":
                open_in = open_in or p["timestamp"]
            elif p["type"] == "CHECK_OUT" and open_in:
                worked += _minutes_between(open_in, p["timestamp"])
                open_in = None

        first_in = check_ins[0] if check_ins else None
        delay = int(first_in["delay_minutes"] or 0) if first_in else 0
        is_late = bool(first_in["is_late"]) if first_in else False

        if not first_in:
            situation = "Só saída"
        elif open_in is not None:
            situation = "Sem saída"
        elif is_late:
            situation = "Atrasado"
        else:
            situation = "Presente"

        rows.append({
            "date": day,
            "employee_id": emp_id,
            "employee_code": first["code"],
            "employee_name": first["name"],
            "department": first["department"],
            "expected_start": first["work_start_time"] or "08:00",
            "first_in": first_in["timestamp"][11:16] if first_in else None,
            "last_out": check_outs[-1]["timestamp"][11:16] if check_outs else None,
            "worked_minutes": worked,
            "delay_minutes": delay if is_late else 0,
            "is_late": is_late,
            "punches": len(items),
            "situation": situation,
        })
    return rows


def employee_totals(employees, summary):
    """Totais do período por colaborador (inclui quem não teve nenhuma presença)."""
    totals = OrderedDict()
    for e in employees:
        totals[e["id"]] = {
            "employee_code": e["code"], "employee_name": e["name"], "department": e["department"],
            "days_present": 0, "days_late": 0, "delay_minutes": 0, "worked_minutes": 0, "days_without_exit": 0,
        }
    for r in summary:
        t = totals.get(r["employee_id"])
        if t is None:
            continue
        t["days_present"] += 1
        t["days_late"] += 1 if r["is_late"] else 0
        t["delay_minutes"] += r["delay_minutes"]
        t["worked_minutes"] += r["worked_minutes"]
        t["days_without_exit"] += 1 if r["situation"] == "Sem saída" else 0
    return list(totals.values())


def absent_on(employees, summary, day: str):
    present = {r["employee_id"] for r in summary if r["date"] == day}
    return [
        {"employee_id": e["id"], "employee_code": e["code"], "employee_name": e["name"],
         "department": e["department"], "role": e["role"], "expected_start": e["work_start_time"] or "08:00",
         "has_fingerprint": bool(e["has_fingerprint"])}
        for e in employees if e["id"] not in present
    ]


def fmt_hours(minutes: int) -> str:
    if not minutes:
        return "0h00"
    return f"{minutes // 60}h{minutes % 60:02d}"


# ---------------------------------------------------------------- CSV

def build_csv(punches) -> str:
    out = io.StringIO()
    out.write("﻿")  # BOM: o Excel abre os acentos corretamente
    w = csv.writer(out, delimiter=";")
    w.writerow(["ID", "Data", "Hora", "Código", "Nome", "Departamento", "Cargo", "Horário Previsto",
                "Tipo", "Atrasado?", "Minutos de Atraso", "Status", "Dispositivo", "Humancore"])
    sync_labels = {"SENT": "Enviada", "PENDING": "Pendente", "ERROR": "Erro"}
    for r in punches:
        w.writerow([
            r["id"], f"{r['timestamp'][8:10]}/{r['timestamp'][5:7]}/{r['timestamp'][:4]}", r["timestamp"][11:19],
            r["code"], r["name"], r["department"], r["role"], r["work_start_time"],
            "Entrada" if r["type"] == "CHECK_IN" else "Saída",
            "SIM" if r["is_late"] else "NÃO", r["delay_minutes"] or 0,
            r["status"], r["device_info"] or "Terminal", sync_labels.get(r["sync_status"], r["sync_status"]),
        ])
    return out.getvalue()


# ---------------------------------------------------------------- PDF

def build_pdf(start, end, employees, punches) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    summary = daily_summary(punches)
    totals = employee_totals(employees, summary)

    ink = colors.HexColor("#0f172a")
    muted = colors.HexColor("#64748b")
    line = colors.HexColor("#e2e8f0")
    head_bg = colors.HexColor("#f1f5f9")
    accent = colors.HexColor("#059669")
    late_c = colors.HexColor("#b45309")
    bad_c = colors.HexColor("#be123c")

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Title"], fontSize=17, leading=21, textColor=ink, alignment=0, spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=12, leading=15, textColor=ink, spaceBefore=10, spaceAfter=6)
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=muted)
    cell = ParagraphStyle("cell", parent=styles["Normal"], fontSize=8, leading=10, textColor=ink)

    def P(text):
        return Paragraph(xml_escape(str(text or "")), cell)

    generated = now_local().strftime("%d/%m/%Y %H:%M")
    single_day = start == end

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(muted)
        canvas.drawString(12 * mm, 8 * mm, f"Ponto Biométrico — Relatório {period_label(start, end)} — gerado em {generated}")
        canvas.drawRightString(doc.pagesize[0] - 12 * mm, 8 * mm, f"Página {doc.page}")
        canvas.restoreState()

    def table(data, widths, align_right_from=None, situation_col=None):
        t = Table(data, colWidths=widths, repeatRows=1)
        style = [
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
            ("TEXTCOLOR", (0, 0), (-1, 0), muted),
            ("BACKGROUND", (0, 0), (-1, 0), head_bg),
            ("LINEBELOW", (0, 0), (-1, -1), 0.4, line),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ]
        if align_right_from is not None:
            style.append(("ALIGN", (align_right_from, 0), (-1, -1), "RIGHT"))
        if situation_col is not None:
            for i, row in enumerate(data[1:], start=1):
                val = row[situation_col]
                color = {"Atrasado": late_c, "Sem saída": bad_c, "Só saída": bad_c, "Sem registo": bad_c}.get(val, accent)
                style.append(("TEXTCOLOR", (situation_col, i), (situation_col, i), color))
                style.append(("FONT", (situation_col, i), (situation_col, i), "Helvetica-Bold", 8))
        t.setStyle(TableStyle(style))
        return t

    story = [
        Paragraph("Relatório de Assiduidade", h1),
        Paragraph(f"Período: <b>{period_label(start, end)}</b> &nbsp;•&nbsp; Gerado em {generated}", small),
        Spacer(1, 8),
    ]

    # KPIs
    present_emp = len({r["employee_id"] for r in summary})
    late_days = sum(1 for r in summary if r["is_late"])
    delay_total = sum(r["delay_minutes"] for r in summary)
    worked_total = sum(r["worked_minutes"] for r in summary)
    kpis = [
        ["Colaboradores", "Com presença", "Batidas", "Entradas atrasadas", "Minutos de atraso", "Horas trabalhadas"],
        [str(len(employees)), str(present_emp), str(len(punches)), str(late_days), str(delay_total), fmt_hours(worked_total)],
    ]
    k = Table(kpis, colWidths=[44 * mm] * 6)
    k.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica", 7.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), muted),
        ("FONT", (0, 1), (-1, 1), "Helvetica-Bold", 14),
        ("TEXTCOLOR", (0, 1), (-1, 1), ink),
        ("BOX", (0, 0), (-1, -1), 0.5, line),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, line),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [k, Spacer(1, 6)]

    if single_day:
        day = f"{start:%Y-%m-%d}"
        story.append(Paragraph("Presenças do dia", h2))
        data = [["Colaborador", "Código", "Departamento", "Previsto", "Entrada", "Saída", "Horas", "Atraso", "Situação"]]
        for r in summary:
            data.append([P(r["employee_name"]), P(r["employee_code"]), P(r["department"]),
                         r["expected_start"], r["first_in"] or "—", r["last_out"] or "—",
                         fmt_hours(r["worked_minutes"]), f"{r['delay_minutes']} min" if r["delay_minutes"] else "—",
                         r["situation"]])
        if len(data) == 1:
            story.append(Paragraph("Nenhuma batida registada neste dia.", small))
        else:
            story.append(table(data, [64 * mm, 32 * mm, 41 * mm, 18 * mm, 18 * mm, 18 * mm, 18 * mm, 20 * mm, 30 * mm], situation_col=8))

        absent = absent_on(employees, summary, day)
        story.append(Paragraph(f"Sem registo neste dia ({len(absent)})", h2))
        if absent:
            data = [["Colaborador", "Código", "Departamento", "Cargo", "Horário previsto", "Situação"]]
            for a in absent:
                data.append([P(a["employee_name"]), P(a["employee_code"]), P(a["department"]),
                             P(a["role"]), a["expected_start"], "Sem registo"])
            story.append(table(data, [72 * mm, 34 * mm, 50 * mm, 52 * mm, 30 * mm, 25 * mm], situation_col=5))
        else:
            story.append(Paragraph("Todos os colaboradores registaram presença.", small))
    else:
        story.append(Paragraph("Resumo por colaborador", h2))
        data = [["Colaborador", "Código", "Departamento", "Dias c/ presença", "Dias c/ atraso", "Min. atraso", "Horas trabalhadas", "Dias sem saída"]]
        for t in totals:
            data.append([P(t["employee_name"]), P(t["employee_code"]), P(t["department"]),
                         str(t["days_present"]), str(t["days_late"]), str(t["delay_minutes"]),
                         fmt_hours(t["worked_minutes"]), str(t["days_without_exit"])])
        story.append(table(data, [66 * mm, 34 * mm, 44 * mm, 26 * mm, 24 * mm, 22 * mm, 30 * mm, 24 * mm], align_right_from=3))

        story.append(Paragraph("Detalhe diário", h2))
        data = [["Data", "Colaborador", "Departamento", "Previsto", "Entrada", "Saída", "Horas", "Atraso", "Situação"]]
        for r in summary:
            d = r["date"]
            data.append([f"{d[8:10]}/{d[5:7]}/{d[:4]}", P(r["employee_name"]), P(r["department"]),
                         r["expected_start"], r["first_in"] or "—", r["last_out"] or "—",
                         fmt_hours(r["worked_minutes"]), f"{r['delay_minutes']} min" if r["delay_minutes"] else "—",
                         r["situation"]])
        if len(data) == 1:
            story.append(Paragraph("Nenhuma batida registada neste período.", small))
        else:
            story.append(table(data, [22 * mm, 68 * mm, 45 * mm, 18 * mm, 18 * mm, 18 * mm, 18 * mm, 20 * mm, 30 * mm], situation_col=8))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm,
                            topMargin=12 * mm, bottomMargin=14 * mm,
                            title=f"Relatório de Assiduidade {period_label(start, end)}", author="Ponto Biométrico")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
