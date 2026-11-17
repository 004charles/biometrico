import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Verifica se o celular possui suporte a hardware biométrico (leitor de digital ou FaceID)
 * e se há ao menos uma biometria cadastrada no sistema.
 */
export async function checkBiometricsSupport() {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();

    return {
      supported: hasHardware && isEnrolled,
      hasHardware,
      isEnrolled,
      supportedTypes, // 1: Impressão Digital, 2: Reconhecimento Facial
    };
  } catch (error) {
    console.error("Erro ao checar hardware biométrico:", error);
    return { supported: false };
  }
}

/**
 * Dispara o diálogo nativo do sistema operacional (Android ou iOS)
 * solicitando a impressão digital do colaborador.
 */
export async function authenticateWithFingerprint(
  promptMessage = "Toque no sensor biométrico para registrar sua presença"
) {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: "Cancelar",
      disableDeviceFallback: false,
    });

    return {
      success: result.success,
      error: result.error || null,
    };
  } catch (error) {
    console.error("Erro na validação biométrica:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
