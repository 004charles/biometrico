"""Integração com o Humancore HRMS e fila de envio de batidas.

Cada batida é gravada com sync_status = 'PENDING'. Este módulo envia-as ao Humancore
e marca-as como 'SENT'. Se o envio falhar, a batida continua na fila e é reenviada
automaticamente, com intervalos crescentes (1, 2, 4, 8, 16, 32 e no máximo 60 min).

Estados:
  PENDING -> ainda não chegou ao Humancore (falha de rede, Humancore em baixo...)
  ERROR   -> o Humancore respondeu mas recusou (ex: funcionário inexistente lá).
             Continua a ser tentado, para o caso de o problema ser resolvido no Humancore.
  SENT    -> confirmado pelo Humancore.
"""
import datetime
import json
import os
import sqlite3
import threading
import urllib.error
import urllib.request

from .database import DB_PATH
from .timeutil import DB_TIME_FORMAT, now_local, now_db_str, parse_db_time, to_iso

HUMANCORE_URL = os.environ.get("HUMANCORE_URL", "http://127.0.0.1:5173/api/v1")
HUMANCORE_TOKEN = os.environ.get("HUMANCORE_TOKEN", "30|xG7uKPHrjRZuriX39hCFq0Q25KKN9OWYTkE2maIN37f70bf2")
HUMANCORE_TENANT_ID = os.environ.get("HUMANCORE_TENANT_ID", "8")
DEFAULT_DEVICE_NAME = "Tablet Entrada SCKJ"

MAX_BACKOFF_MINUTES = 60
BATCH_LIMIT = 100

# Garante que a mesma batida não é enviada duas vezes ao mesmo tempo
# (envio imediato da batida + tarefa de fundo).
_send_lock = threading.Lock()


class HumancoreResult:
    def __init__(self, ok: bool, body=None, error: str = None, retryable: bool = True):
        self.ok = ok
        self.body = body
        self.error = error
        self.retryable = retryable  # False = o Humancore recusou (erro 4xx / success=false)


def humancore_request(path: str, method: str = "GET", data: dict = None, timeout: float = 8) -> HumancoreResult:
    url = f"{HUMANCORE_URL}{path}"
    headers = {
        "Authorization": f"Bearer {HUMANCORE_TOKEN}",
        "X-Tenant-ID": str(HUMANCORE_TENANT_ID),
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            parsed = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read().decode("utf-8") or "{}")
            msg = err_body.get("message") or str(err_body)[:300]
        except Exception:
            msg = e.reason
        # 408/429/5xx são temporários; os restantes 4xx são recusas do Humancore
        retryable = e.code in (408, 429) or e.code >= 500
        return HumancoreResult(False, error=f"HTTP {e.code}: {msg}", retryable=retryable)
    except Exception as e:
        return HumancoreResult(False, error=f"Sem ligação ao Humancore: {e}", retryable=True)

    if isinstance(parsed, dict) and parsed.get("success") is False:
        return HumancoreResult(False, body=parsed, error=parsed.get("message") or "Recusado pelo Humancore", retryable=False)
    return HumancoreResult(True, body=parsed)


def call_humancore(path: str, method: str = "GET", data: dict = None):
    """Compatibilidade: devolve o JSON da resposta ou None em caso de erro."""
    res = humancore_request(path, method, data)
    if not res.ok:
        print(f"Erro ao comunicar com Humancore [{method} {path}]:", res.error)
    return res.body


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def _build_payload(row) -> dict:
    direction = "in" if row["type"] == "CHECK_IN" else ("out" if row["type"] == "CHECK_OUT" else "auto")
    return {
        "biometric_code": str(row["biometric_code"] or row["code"]),
        "punched_at": to_iso(parse_db_time(row["timestamp"])),
        "direction": direction,
        "device_name": row["device_info"] or DEFAULT_DEVICE_NAME,
    }


def _next_try(attempts: int) -> str:
    wait = min(2 ** max(attempts - 1, 0), MAX_BACKOFF_MINUTES)
    return (now_local() + datetime.timedelta(minutes=wait)).strftime(DB_TIME_FORMAT)


def send_record(record_id: int, timeout: float = 8) -> dict:
    """Envia UMA batida ao Humancore e atualiza o seu estado na fila.

    Devolve {"status": ..., "error": ..., "late_minutes": ...}.
    """
    with _send_lock:
        conn = _connect()
        try:
            row = conn.execute("""
                SELECT a.id, a.timestamp, a.type, a.device_info, a.sync_status, a.sync_attempts,
                       e.code, e.biometric_code
                FROM attendance a JOIN employees e ON e.id = a.employee_id
                WHERE a.id = ?
            """, (record_id,)).fetchone()
            if row is None:
                return {"status": "MISSING", "error": "Batida não encontrada", "late_minutes": None}
            if row["sync_status"] == "SENT":
                return {"status": "SENT", "error": None, "late_minutes": None}

            res = humancore_request("/integrations/biometric/attendance", method="POST",
                                    data=_build_payload(row), timeout=timeout)
            attempts = (row["sync_attempts"] or 0) + 1

            if res.ok:
                late = None
                results = (res.body or {}).get("data", {}).get("results", []) if isinstance(res.body, dict) else []
                if results and results[0].get("late_minutes") is not None:
                    late = int(results[0]["late_minutes"])
                    conn.execute("UPDATE attendance SET delay_minutes = ?, is_late = ? WHERE id = ?",
                                 (late, 1 if late > 0 else 0, record_id))
                conn.execute("""
                    UPDATE attendance
                    SET sync_status = 'SENT', sync_attempts = ?, sync_error = NULL,
                        synced_at = ?, sync_next_try = NULL
                    WHERE id = ?
                """, (attempts, now_db_str(), record_id))
                conn.commit()
                return {"status": "SENT", "error": None, "late_minutes": late}

            status = "PENDING" if res.retryable else "ERROR"
            conn.execute("""
                UPDATE attendance
                SET sync_status = ?, sync_attempts = ?, sync_error = ?, sync_next_try = ?
                WHERE id = ?
            """, (status, attempts, (res.error or "")[:500], _next_try(attempts), record_id))
            conn.commit()
            print(f"Humancore: batida {record_id} não enviada ({status}, tentativa {attempts}): {res.error}")
            return {"status": status, "error": res.error, "late_minutes": None}
        finally:
            conn.close()


def process_queue(force: bool = False) -> dict:
    """Envia as batidas por enviar. force=True ignora o tempo de espera entre tentativas."""
    conn = _connect()
    try:
        if force:
            rows = conn.execute("""
                SELECT id FROM attendance WHERE sync_status IN ('PENDING', 'ERROR')
                ORDER BY id ASC LIMIT ?
            """, (BATCH_LIMIT,)).fetchall()
        else:
            rows = conn.execute("""
                SELECT id FROM attendance
                WHERE sync_status IN ('PENDING', 'ERROR')
                  AND (sync_next_try IS NULL OR sync_next_try <= ?)
                ORDER BY id ASC LIMIT ?
            """, (now_db_str(), BATCH_LIMIT)).fetchall()
    finally:
        conn.close()

    sent = failed = 0
    for r in rows:
        result = send_record(r["id"])
        if result["status"] == "SENT":
            sent += 1
        elif result["status"] in ("PENDING", "ERROR"):
            failed += 1
            # Se o Humancore está inacessível, não vale a pena tentar as restantes agora
            if result["status"] == "PENDING":
                break

    summary = queue_summary()
    summary.update({"sent_now": sent, "failed_now": failed})
    return summary


def queue_summary(day: str = None) -> dict:
    conn = _connect()
    try:
        params = []
        where = ""
        if day:
            where = "WHERE timestamp LIKE ?"
            params.append(f"{day}%")
        counts = {r["sync_status"]: r["n"] for r in conn.execute(
            f"SELECT sync_status, COUNT(*) AS n FROM attendance {where} GROUP BY sync_status", params)}
        last_err = conn.execute("""
            SELECT sync_error FROM attendance
            WHERE sync_status IN ('PENDING', 'ERROR') AND sync_error IS NOT NULL
            ORDER BY id DESC LIMIT 1
        """).fetchone()
        oldest = conn.execute("""
            SELECT MIN(timestamp) AS t FROM attendance WHERE sync_status IN ('PENDING', 'ERROR')
        """).fetchone()
    finally:
        conn.close()
    return {
        "pending": counts.get("PENDING", 0),
        "error": counts.get("ERROR", 0),
        "sent": counts.get("SENT", 0),
        "last_error": last_err["sync_error"] if last_err else None,
        "oldest_unsent": oldest["t"] if oldest else None,
    }
