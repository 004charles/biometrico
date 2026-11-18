"""Hora oficial do sistema.

Toda marcação usa a hora do SERVIDOR (sincronizado por NTP), nunca a do telemóvel,
sempre no fuso da empresa — mesmo que a máquina esteja configurada em UTC.
"""
import os
import datetime
from zoneinfo import ZoneInfo

APP_TIMEZONE = ZoneInfo(os.environ.get("APP_TIMEZONE", "Africa/Luanda"))
DB_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def now_local() -> datetime.datetime:
    """Hora atual no fuso da empresa (com fuso horário), sem microssegundos."""
    return datetime.datetime.now(APP_TIMEZONE).replace(microsecond=0)


def now_db_str() -> str:
    return now_local().strftime(DB_TIME_FORMAT)


def today_local_str() -> str:
    return now_local().strftime("%Y-%m-%d")


def parse_db_time(value: str) -> datetime.datetime:
    """Converte a hora gravada na BD (hora local, sem fuso) para datetime com fuso."""
    return datetime.datetime.strptime(value, DB_TIME_FORMAT).replace(tzinfo=APP_TIMEZONE)


def to_iso(dt: datetime.datetime) -> str:
    """ISO 8601 com o deslocamento correto (ex: 2026-11-18T07:45:00+01:00)."""
    return dt.isoformat(timespec="seconds")
