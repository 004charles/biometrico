// Configure com o endereço IP da máquina onde o backend FastAPI está rodando
// Exemplo: "http://192.168.1.15:8000"
export const API_BASE_URL = "http://192.168.146.75:8000";

/**
 * Envia o registro de ponto completo para o backend e dashboard.
 */
export async function sendPunchRecord({
  employeeCode,
  recordType = "CHECK_IN", // CHECK_IN ou CHECK_OUT
  fingerprintVerified,
  photoUri,
  latitude = null,
  longitude = null,
  deviceInfo = "Smartphone Android/iOS",
  baseUrl = API_BASE_URL
}) {
  const formData = new FormData();
  formData.append("employee_code", employeeCode);
  formData.append("record_type", recordType);
  formData.append("fingerprint_verified", String(fingerprintVerified));
  formData.append("device_info", deviceInfo);

  if (latitude !== null && longitude !== null) {
    formData.append("latitude", String(latitude));
    formData.append("longitude", String(longitude));
  }

  if (photoUri) {
    // Tratar o arquivo da foto da câmara
    const filename = photoUri.split('/').pop() || "punch.jpg";
    const match = /\.(\w+)$/.exec(filename);
    const type = match ? `image/${match[1]}` : 'image/jpeg';

    formData.append("photo", {
      uri: photoUri,
      name: filename,
      type: type,
    });
  }

  const response = await fetch(`${baseUrl}/api/attendance/punch`, {
    method: "POST",
    body: formData,
    headers: {
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || "Falha ao registrar ponto.");
  }

  return await response.json();
}

/**
 * Lista os funcionários ativos cadastrados na empresa
 */
export async function fetchEmployees(baseUrl = API_BASE_URL) {
  const response = await fetch(`${baseUrl}/api/employees`);
  if (!response.ok) throw new Error("Erro ao buscar funcionários.");
  return await response.json();
}
