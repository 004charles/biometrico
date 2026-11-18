from pydantic import BaseModel
from typing import Optional, List

class EmployeeBase(BaseModel):
    code: str
    name: str
    department: str
    role: str
    work_start_time: Optional[str] = "08:00"
    tolerance_minutes: Optional[int] = 10
    biometric_code: Optional[str] = None
    has_fingerprint: Optional[bool] = False
    has_face: Optional[bool] = False

class EmployeeResponse(EmployeeBase):
    id: int
    created_at: str

class AttendanceRecordResponse(BaseModel):
    id: int
    employee_id: int
    employee_name: str
    employee_code: str
    department: str
    timestamp: str
    type: str # CHECK_IN, CHECK_OUT
    fingerprint_verified: bool
    delay_minutes: int
    is_late: bool
    device_info: Optional[str] = None
    status: str
    sync_status: str = "SENT"          # PENDING, SENT, ERROR (envio ao Humancore)
    sync_error: Optional[str] = None
    sync_attempts: int = 0

class DashboardStats(BaseModel):
    date: Optional[str] = None    # Dia a que as estatísticas se referem (AAAA-MM-DD)
    is_today: bool = True
    total_employees: int
    present_today: int            # Quantos presentes hoje
    absent_today: int             # Quantos faltaram hoje
    late_today: int               # Quantos chegaram atrasados
    total_delay_minutes: int      # Minutos totais de atraso
    today_punches: int
    recent_records: List[AttendanceRecordResponse]
    sync_pending: int = 0         # Batidas à espera de envio ao Humancore
    sync_errors: int = 0          # Batidas recusadas pelo Humancore
    sync_last_error: Optional[str] = None
