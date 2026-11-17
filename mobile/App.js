import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
  Modal,
  Vibration,
  ScrollView,
  Image
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

// IP público da VPS
const DEFAULT_SERVER_URL = "http://2.29.174.170:8000";
const ADMIN_MASTER_CODE = "12345677654321";

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [typedCode, setTypedCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'success' | 'error', title, msg }
  
  // Modal de Admin (Acessado com o código 12345677654321)
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [employees, setEmployees] = useState([]);
  
  // Campos do novo funcionário no modal admin
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newDept, setNewDept] = useState("");
  const [newRole, setNewRole] = useState("");
  const [newStartTime, setNewStartTime] = useState("08:00");
  const [newTolerance, setNewTolerance] = useState("10");
  const [adminLoading, setAdminLoading] = useState(false);

  // Sincronização Humancore e Cadastro Biométrico (3 Leituras de Dedo)
  const [syncLoading, setSyncLoading] = useState(false);
  const [enrollModalVisible, setEnrollModalVisible] = useState(false);
  const [enrollingEmp, setEnrollingEmp] = useState(null);
  const [enrollStep, setEnrollStep] = useState(1);
  const [enrollReading, setEnrollReading] = useState(false);

  // Monitora digitação do código mestre
  useEffect(() => {
    if (typedCode === ADMIN_MASTER_CODE) {
      setTypedCode("");
      setIsAdminOpen(true);
      fetchEmployees();
    }
  }, [typedCode]);

  // Carregar lista de colaboradores para o painel admin
  const fetchEmployees = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/employees`);
      if (res.ok) {
        const data = await res.json();
        setEmployees(data);
      }
    } catch (e) {
      console.log("Erro ao carregar colaboradores:", e.message);
    }
  };

  // 1. Teclado Numérico
  const handleKeyPress = (val) => {
    if (typedCode.length < 16) {
      setTypedCode(prev => prev + val);
    }
  };

  const handleClear = () => {
    setTypedCode("");
  };

  const handleBackspace = () => {
    setTypedCode(prev => prev.slice(0, -1));
  };

  // 2. Colocar o Dedo no Sensor Biométrico
  const handleFingerprintTouch = async () => {
    setFeedback(null);

    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (!hasHardware || !isEnrolled) {
      // Se não há sensor ou digital cadastrada no aparelho
      if (!typedCode) {
        setFeedback({
          type: "error",
          title: "Usuário não encontrado",
          msg: "Digite o seu código de colaborador no teclado abaixo."
        });
        return;
      }
      sendPunch(typedCode);
      return;
    }

    try {
      const bioResult = await LocalAuthentication.authenticateAsync({
        promptMessage: "Coloque o dedo no leitor biométrico",
        cancelLabel: "Cancelar",
        disableDeviceFallback: false,
      });

      if (bioResult.success) {
        try { Vibration.vibrate(100); } catch(e) {}
        if (typedCode) {
          sendPunch(typedCode);
        } else {
          sendPunch("BIO_DIRECT");
        }
      } else {
        setFeedback({
          type: "error",
          title: "Usuário não encontrado",
          msg: "Impressão digital não reconhecida ou não cadastrada."
        });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        title: "Usuário não encontrado",
        msg: "Digital não reconhecida."
      });
    }
  };

  // 3. Confirmar Batida de Ponto
  const handleConfirmPunch = () => {
    if (!typedCode) {
      setFeedback({
        type: "error",
        title: "Usuário não encontrado",
        msg: "Por favor, digite o seu código de funcionário."
      });
      return;
    }

    // Se digitou o código de admin
    if (typedCode === ADMIN_MASTER_CODE) {
      setTypedCode("");
      setIsAdminOpen(true);
      fetchEmployees();
      return;
    }

    sendPunch(typedCode);
  };

  const sendPunch = async (code) => {
    setLoading(true);
    setFeedback(null);

    const payload = {
      employee_code: code.trim(),
      record_type: "AUTO",
      fingerprint_verified: true,
      device_info: "App Mobile Biométrico"
    };

    try {
      const res = await fetch(`${serverUrl}/api/attendance/punch`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.status === 404) {
        setFeedback({
          type: "error",
          title: "Usuário não encontrado",
          msg: "Este código ou digital não pertence a nenhum funcionário cadastrado."
        });
        setTypedCode("");
      } else if (data.success) {
        setFeedback({
          type: "success",
          title: `Ponto Registrado (${data.type_label})`,
          msg: data.message
        });
        setTypedCode("");
      } else {
        setFeedback({
          type: "error",
          title: "Usuário não encontrado",
          msg: data.message || "Não foi possível registrar o ponto."
        });
      }
    } catch (err) {
      console.log("Erro de conexão:", err);
      setFeedback({
        type: "error",
        title: "Falha de Conexão",
        msg: `Servidor inacessível (${serverUrl}). ${err.message || ""}`
      });
    } finally {
      setLoading(false);
      // Auto-limpar feedback após 3.5 segundos
      setTimeout(() => {
        setFeedback(null);
      }, 3500);
    }
  };

  const handleTestConnection = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/health`);
      if (res.ok) {
        Alert.alert("Sucesso", "Conectado ao servidor da VPS com sucesso!");
      } else {
        Alert.alert("Aviso", `Servidor respondeu com código ${res.status}`);
      }
    } catch (e) {
      Alert.alert("Erro de Conexão", `Não foi possível conectar: ${e.message}`);
    }
  };

  // 3.1 Sincronizar Funcionários do Humancore HRMS
  const handleSyncHumancore = async () => {
    setSyncLoading(true);
    try {
      const res = await fetch(`${serverUrl}/api/humancore/sync`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        Alert.alert("Humancore Sincronizado", data.message || "Colaboradores importados!");
        fetchEmployees();
      } else {
        Alert.alert("Aviso", data.detail || "Erro ao sincronizar com Humancore.");
      }
    } catch (e) {
      Alert.alert("Erro", "Falha de conexão com o servidor da VPS.");
    } finally {
      setSyncLoading(false);
    }
  };

  // 3.2 Iniciar Cadastro Biométrico (3 Leituras)
  const handleStartEnrollment = (emp) => {
    setEnrollingEmp(emp);
    setEnrollStep(1);
    setEnrollModalVisible(true);
  };

  // 3.3 Capturar Leitura do Dedo (Passos 1, 2 e 3)
  const handleCaptureEnrollFinger = async () => {
    if (enrollReading || !enrollingEmp) return;
    setEnrollReading(true);

    try {
      const stepText = enrollStep === 1 
        ? `Coloque o dedo de ${enrollingEmp.name} (1ª Leitura)` 
        : enrollStep === 2 
        ? `Coloque o MESMO dedo novamente (2ª Leitura)` 
        : `Coloque o dedo uma última vez para confirmar (3ª Leitura)`;

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: stepText,
        cancelLabel: "Cancelar",
        disableDeviceFallback: false,
      });

      if (result.success) {
        try { Vibration.vibrate(100); } catch(e) {}

        if (enrollStep === 1) {
          setEnrollStep(2);
        } else if (enrollStep === 2) {
          setEnrollStep(3);
        } else if (enrollStep === 3) {
          await finalizeEnrollment(enrollingEmp);
        }
      } else {
        Alert.alert("Atenção", "Digital não reconhecida. Tente novamente com o mesmo dedo.");
      }
    } catch (err) {
      Alert.alert("Erro", "Sensor biométrico: " + err.message);
    } finally {
      setEnrollReading(false);
    }
  };

  // 3.4 Concluir e Sincronizar no Humancore
  const finalizeEnrollment = async (emp) => {
    try {
      const res = await fetch(`${serverUrl}/api/employees/${emp.id}/enroll-fingerprint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          biometric_code: emp.biometric_code || emp.code
        })
      });
      const data = await res.json();
      if (res.ok) {
        Alert.alert(
          "Sucesso!", 
          `A impressão digital de ${emp.name} foi cadastrada com sucesso e sincronizada com o Humancore!`
        );
        setEnrollModalVisible(false);
        setEnrollingEmp(null);
        setEnrollStep(1);
        fetchEmployees();
      } else {
        Alert.alert("Erro", data.detail || "Erro ao salvar biometria.");
      }
    } catch (e) {
      Alert.alert("Erro", "Falha de rede ao salvar biometria.");
    }
  };

  // 4. Cadastrar Novo Funcionário (No Modal Admin)
  const handleCreateEmployee = async () => {
    if (!newCode.trim() || !newName.trim()) {
      Alert.alert("Atenção", "Preencha ao menos o Código e o Nome.");
      return;
    }

    setAdminLoading(true);
    const form = new FormData();
    form.append("code", newCode.trim().toUpperCase());
    form.append("name", newName.trim());
    form.append("department", newDept.trim() || "Geral");
    form.append("role", newRole.trim() || "Colaborador");
    form.append("work_start_time", newStartTime.trim() || "08:00");
    form.append("tolerance_minutes", newTolerance.trim() || "10");

    try {
      const res = await fetch(`${serverUrl}/api/employees`, {
        method: "POST",
        body: form
      });
      const data = await res.json();
      if (res.ok) {
        Alert.alert("Sucesso", `Funcionário ${data.name} cadastrado com sucesso!`);
        setNewCode("");
        setNewName("");
        setNewDept("");
        setNewRole("");
        fetchEmployees();
      } else {
        Alert.alert("Erro", data.detail || "Erro ao cadastrar funcionário.");
      }
    } catch (e) {
      Alert.alert("Erro", "Falha de conexão com o servidor.");
    } finally {
      setAdminLoading(false);
    }
  };

  // 5. Excluir Funcionário (No Modal Admin)
  const handleDeleteEmployee = async (id, name) => {
    Alert.alert(
      "Confirmar Exclusão",
      `Deseja realmente remover o colaborador ${name}?`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Excluir",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await fetch(`${serverUrl}/api/employees/${id}`, { method: "DELETE" });
              if (res.ok) {
                fetchEmployees();
              }
            } catch (e) {
              Alert.alert("Erro", "Falha ao excluir.");
            }
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      {/* ÁREA CENTRAL: FUNDO TOTALMENTE BRANCO E LIMPO */}
      <View style={styles.content}>

        {/* 👆 ONDE SE PÕE O DEDO: Ícone de Impressão Digital */}
        <TouchableOpacity
          style={styles.fingerprintButton}
          onPress={handleFingerprintTouch}
          activeOpacity={0.7}
        >
          <View style={styles.fingerprintCircle}>
            <Image
              source={require('./assets/fingerprint.png')}
              style={styles.fingerprintImage}
              resizeMode="contain"
            />
          </View>
        </TouchableOpacity>

        {/* Visor dos Números Digitados */}
        <View style={styles.displayContainer}>
          <Text style={styles.displayText}>
            {typedCode ? typedCode : "• • •"}
          </Text>
        </View>

        {/* Feedback de Sucesso ou "Usuário Não Encontrado" */}
        {feedback && (
          <View style={[
            styles.feedbackBox,
            feedback.type === "success" ? styles.feedbackSuccess : styles.feedbackError
          ]}>
            <Text style={[
              styles.feedbackTitle,
              feedback.type === "success" ? styles.feedbackTitleSuccess : styles.feedbackTitleError
            ]}>
              {feedback.title}
            </Text>
            <Text style={styles.feedbackMsg}>{feedback.msg}</Text>
          </View>
        )}

        {/* 🔢 TECLADO DE DIGITAR OS NÚMEROS */}
        <View style={styles.keypad}>
          <View style={styles.keyRow}>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("1")}>
              <Text style={styles.keyNumber}>1</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("2")}>
              <Text style={styles.keyNumber}>2</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("3")}>
              <Text style={styles.keyNumber}>3</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.keyRow}>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("4")}>
              <Text style={styles.keyNumber}>4</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("5")}>
              <Text style={styles.keyNumber}>5</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("6")}>
              <Text style={styles.keyNumber}>6</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.keyRow}>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("7")}>
              <Text style={styles.keyNumber}>7</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("8")}>
              <Text style={styles.keyNumber}>8</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("9")}>
              <Text style={styles.keyNumber}>9</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.keyRow}>
            <TouchableOpacity style={[styles.keyBtn, styles.keyBtnSpecial]} onPress={handleClear}>
              <Text style={styles.keySpecialText}>C</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.keyBtn} onPress={() => handleKeyPress("0")}>
              <Text style={styles.keyNumber}>0</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.keyBtn, styles.keyBtnSpecial]} onPress={handleBackspace}>
              <Text style={styles.keySpecialText}>⌫</Text>
            </TouchableOpacity>
          </View>

          {/* Botão de Confirmação */}
          <TouchableOpacity
            style={styles.confirmBtn}
            onPress={handleConfirmPunch}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.confirmBtnText}>Confirmar</Text>
            )}
          </TouchableOpacity>
        </View>

      </View>

      {/* 🔐 MODAL DE CONFIGURAÇÃO E CADASTRO (CÓDIGO: 12345677654321) */}
      <Modal visible={isAdminOpen} animationType="slide">
        <SafeAreaView style={styles.adminContainer}>
          <View style={styles.adminHeader}>
            <Text style={styles.adminHeaderTitle}>Gestão de Colaboradores</Text>
            <TouchableOpacity onPress={() => setIsAdminOpen(false)} style={styles.adminCloseBtn}>
              <Text style={styles.adminCloseText}>✕ Fechar</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.adminScroll}>
            {/* Integração Humancore HRMS */}
            <View style={[styles.adminCard, styles.humancoreCard]}>
              <View style={styles.humancoreHeader}>
                <View style={styles.flex1}>
                  <Text style={styles.humancoreTitle}>Humancore HRMS (SCKJ)</Text>
                  <Text style={styles.humancoreSubtitle}>
                    Sincronize os colaboradores e associe o dedo de cada um com 3 toques.
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.syncBtn}
                  onPress={handleSyncHumancore}
                  disabled={syncLoading}
                >
                  {syncLoading ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.syncBtnText}>🔄 Sincronizar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {/* Configuração do Servidor */}
            <View style={styles.adminCard}>
              <Text style={styles.adminSectionTitle}>Servidor VPS / Backend</Text>
              <TextInput
                style={styles.adminInput}
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="http://2.29.174.170:8000"
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={styles.testBtn}
                onPress={handleTestConnection}
              >
                <Text style={styles.testBtnText}>⚡ Testar Conexão com Servidor</Text>
              </TouchableOpacity>
            </View>

            {/* Cadastro de Novo Funcionário */}
            <View style={styles.adminCard}>
              <Text style={styles.adminSectionTitle}>Cadastrar Novo Colaborador</Text>
              
              <Text style={styles.inputLabel}>Código / Matrícula (Ex: 101, 102)</Text>
              <TextInput
                style={styles.adminInput}
                value={newCode}
                onChangeText={setNewCode}
                placeholder="Ex: 101"
                autoCapitalize="characters"
              />

              <Text style={styles.inputLabel}>Nome Completo</Text>
              <TextInput
                style={styles.adminInput}
                value={newName}
                onChangeText={setNewName}
                placeholder="Ex: João Baptista"
              />

              <Text style={styles.inputLabel}>Departamento</Text>
              <TextInput
                style={styles.adminInput}
                value={newDept}
                onChangeText={setNewDept}
                placeholder="Ex: Operações"
              />

              <Text style={styles.inputLabel}>Cargo</Text>
              <TextInput
                style={styles.adminInput}
                value={newRole}
                onChangeText={setNewRole}
                placeholder="Ex: Técnico"
              />

              <View style={styles.row}>
                <View style={styles.flex1}>
                  <Text style={styles.inputLabel}>Hora Entrada</Text>
                  <TextInput
                    style={styles.adminInput}
                    value={newStartTime}
                    onChangeText={setNewStartTime}
                    placeholder="08:00"
                  />
                </View>
                <View style={styles.flex1}>
                  <Text style={styles.inputLabel}>Tolerância (min)</Text>
                  <TextInput
                    style={styles.adminInput}
                    value={newTolerance}
                    onChangeText={setNewTolerance}
                    placeholder="10"
                    keyboardType="numeric"
                  />
                </View>
              </View>

              <TouchableOpacity
                style={styles.adminSaveBtn}
                onPress={handleCreateEmployee}
                disabled={adminLoading}
              >
                {adminLoading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.adminSaveText}>+ Cadastrar Funcionário</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Lista de Colaboradores Existentes */}
            <View style={styles.adminCard}>
              <View style={styles.rowBetween}>
                <Text style={styles.adminSectionTitle}>Colaboradores ({employees.length})</Text>
                <TouchableOpacity onPress={fetchEmployees}>
                  <Text style={styles.refreshText}>🔄 Atualizar</Text>
                </TouchableOpacity>
              </View>

              {employees.length === 0 ? (
                <Text style={styles.emptyText}>Nenhum colaborador sincronizado. Clique em Sincronizar acima.</Text>
              ) : (
                employees.map(emp => (
                  <View key={emp.id} style={styles.empCard}>
                    <View style={styles.empMainInfo}>
                      <View style={styles.empNameRow}>
                        <Text style={styles.empRowName}>{emp.name}</Text>
                        <View style={[
                          styles.statusPill, 
                          emp.has_fingerprint ? styles.statusPillActive : styles.statusPillPending
                        ]}>
                          <Text style={[
                            styles.statusPillText,
                            emp.has_fingerprint ? styles.statusPillTextActive : styles.statusPillTextPending
                          ]}>
                            {emp.has_fingerprint ? "🟢 Digital OK" : "🔴 Pendente"}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.empRowSub}>
                        PIN: {emp.biometric_code || emp.code} • {emp.department} • Entrada: {emp.work_start_time}
                      </Text>
                    </View>

                    <View style={styles.empActionsRow}>
                      <TouchableOpacity
                        onPress={() => handleStartEnrollment(emp)}
                        style={[
                          styles.enrollBtn,
                          emp.has_fingerprint ? styles.enrollBtnDone : styles.enrollBtnPending
                        ]}
                      >
                        <Text style={styles.enrollBtnText}>
                          {emp.has_fingerprint ? "👆 Recadastrar Digital" : "👆 Cadastrar Digital (3x)"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleDeleteEmployee(emp.id, emp.name)}
                        style={styles.empDeleteBtn}
                      >
                        <Text style={styles.empDeleteText}>Excluir</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </View>

          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* 👆 MODAL DE CADASTRO BIOMÉTRICO (3 LEITURAS OBRIGATÓRIAS DO DEDO) */}
      <Modal visible={enrollModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.enrollCard}>
            <Text style={styles.enrollModalTitle}>Cadastrar Impressão Digital</Text>
            {enrollingEmp && (
              <Text style={styles.enrollEmpName}>{enrollingEmp.name}</Text>
            )}
            <Text style={styles.enrollSubtitle}>
              O colaborador deve colocar o mesmo dedo 3 vezes consecutivas no sensor biométrico para confirmar o registro no Humancore.
            </Text>

            {/* Barra de Progresso em 3 Passos */}
            <View style={styles.stepsContainer}>
              <View style={[styles.stepDot, enrollStep >= 1 ? styles.stepDotActive : styles.stepDotInactive]}>
                <Text style={styles.stepDotNum}>1</Text>
              </View>
              <View style={[styles.stepLine, enrollStep >= 2 ? styles.stepLineActive : styles.stepLineInactive]} />
              <View style={[styles.stepDot, enrollStep >= 2 ? styles.stepDotActive : styles.stepDotInactive]}>
                <Text style={styles.stepDotNum}>2</Text>
              </View>
              <View style={[styles.stepLine, enrollStep >= 3 ? styles.stepLineActive : styles.stepLineInactive]} />
              <View style={[styles.stepDot, enrollStep >= 3 ? styles.stepDotActive : styles.stepDotInactive]}>
                <Text style={styles.stepDotNum}>3</Text>
              </View>
            </View>

            {/* Caixa de Instrução Atual */}
            <View style={styles.currentStepBox}>
              <Text style={styles.currentStepTitle}>
                {enrollStep === 1 && "Etapa 1 de 3: Primeira Leitura"}
                {enrollStep === 2 && "Etapa 2 de 3: Confirmação do Dedo"}
                {enrollStep === 3 && "Etapa 3 de 3: Validação Final"}
              </Text>
              <Text style={styles.currentStepDesc}>
                {enrollStep === 1 && "Coloque o dedo no leitor biométrico para capturar a primeira amostra."}
                {enrollStep === 2 && "Coloque o MESMO dedo novamente para validação."}
                {enrollStep === 3 && "Coloque o dedo pela 3ª vez para gravar e sincronizar no Humancore."}
              </Text>
            </View>

            {/* Botão Principal de Leitura */}
            <TouchableOpacity
              style={styles.captureFingerBtn}
              onPress={handleCaptureEnrollFinger}
              disabled={enrollReading}
            >
              {enrollReading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.captureFingerBtnText}>
                  {enrollStep === 1 && "👆 Colocar Dedo (1ª Vez)"}
                  {enrollStep === 2 && "👆 Colocar Dedo Novamente (2ª Vez)"}
                  {enrollStep === 3 && "👆 Confirmar Dedo (3ª Vez)"}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelEnrollBtn}
              onPress={() => {
                setEnrollModalVisible(false);
                setEnrollingEmp(null);
                setEnrollStep(1);
              }}
            >
              <Text style={styles.cancelEnrollBtnText}>Cancelar Cadastro</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff', // Fundo 100% Branco
  },
  content: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  // Onde se põe o dedo
  fingerprintButton: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  fingerprintCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#ffffff',
    borderWidth: 2.5,
    borderColor: '#059669', // Verde Esmeralda
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 3,
  },
  fingerprintImage: {
    width: 80,
    height: 80,
    tintColor: '#059669',
  },
  // Visor numérico
  displayContainer: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  displayText: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#0f172a',
    letterSpacing: 4,
  },
  // Feedback (Sucesso ou "Usuário Não Encontrado")
  feedbackBox: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 16,
    alignItems: 'center',
    maxWidth: '90%',
  },
  feedbackSuccess: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  feedbackError: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  feedbackTitle: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  feedbackTitleSuccess: {
    color: '#059669',
  },
  feedbackTitleError: {
    color: '#dc2626',
  },
  feedbackMsg: {
    fontSize: 12,
    color: '#475569',
    marginTop: 2,
    textAlign: 'center',
  },
  // Teclado Numérico
  keypad: {
    width: '100%',
    maxWidth: 320,
    gap: 12,
  },
  keyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  keyBtn: {
    flex: 1,
    aspectRatio: 1.3,
    backgroundColor: '#f8fafc',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  keyBtnSpecial: {
    backgroundColor: '#f1f5f9',
  },
  keyNumber: {
    fontSize: 26,
    fontWeight: '600',
    color: '#0f172a',
  },
  keySpecialText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#64748b',
  },
  confirmBtn: {
    backgroundColor: '#059669', // Verde corporativo
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 6,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  confirmBtnText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  // Modal de Administração
  adminContainer: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  adminHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  adminHeaderTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  adminCloseBtn: {
    padding: 8,
  },
  adminCloseText: {
    color: '#dc2626',
    fontWeight: 'bold',
    fontSize: 14,
  },
  adminScroll: {
    padding: 16,
    gap: 16,
  },
  adminCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  adminSectionTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#64748b',
    marginTop: 8,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  adminInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  flex1: {
    flex: 1,
  },
  testBtn: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  testBtnText: {
    color: '#2563eb',
    fontWeight: 'bold',
    fontSize: 13,
  },
  adminSaveBtn: {
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  adminSaveText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 13,
    fontStyle: 'italic',
  },
  empRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  empRowName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  empRowSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  empDeleteBtn: {
    backgroundColor: '#fee2e2',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  empDeleteText: {
    color: '#dc2626',
    fontSize: 12,
    fontWeight: 'bold',
  },
  // Integração Humancore Card
  humancoreCard: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
    borderWidth: 1.5,
  },
  humancoreHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  humancoreTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#15803d',
  },
  humancoreSubtitle: {
    fontSize: 12,
    color: '#166534',
    marginTop: 4,
    lineHeight: 16,
  },
  syncBtn: {
    backgroundColor: '#16a34a',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    shadowColor: '#16a34a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  syncBtnText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  refreshText: {
    fontSize: 13,
    color: '#059669',
    fontWeight: '600',
  },
  empCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 10,
  },
  empMainInfo: {
    marginBottom: 8,
  },
  empNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusPill: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  statusPillActive: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  statusPillPending: {
    backgroundColor: '#fff1f2',
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: 'bold',
  },
  statusPillTextActive: {
    color: '#059669',
  },
  statusPillTextPending: {
    color: '#e11d48',
  },
  empActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#f8fafc',
  },
  enrollBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  enrollBtnPending: {
    backgroundColor: '#059669',
  },
  enrollBtnDone: {
    backgroundColor: '#0284c7',
  },
  enrollBtnText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  // Modal de Cadastro Biométrico (3 Passos)
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  enrollCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 15,
    elevation: 8,
  },
  enrollModalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0f172a',
    textAlign: 'center',
  },
  enrollEmpName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#059669',
    marginTop: 4,
    textAlign: 'center',
  },
  enrollSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 16,
  },
  stepsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 20,
    width: '80%',
  },
  stepDot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotActive: {
    backgroundColor: '#059669',
  },
  stepDotInactive: {
    backgroundColor: '#e2e8f0',
  },
  stepDotNum: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  stepLine: {
    flex: 1,
    height: 3,
  },
  stepLineActive: {
    backgroundColor: '#059669',
  },
  stepLineInactive: {
    backgroundColor: '#e2e8f0',
  },
  currentStepBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 14,
    width: '100%',
    marginBottom: 20,
    alignItems: 'center',
  },
  currentStepTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 4,
  },
  currentStepDesc: {
    fontSize: 12,
    color: '#475569',
    textAlign: 'center',
    lineHeight: 16,
  },
  captureFingerBtn: {
    backgroundColor: '#059669',
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
    marginBottom: 10,
  },
  captureFingerBtnText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 15,
  },
  cancelEnrollBtn: {
    paddingVertical: 10,
  },
  cancelEnrollBtnText: {
    color: '#94a3b8',
    fontWeight: '600',
    fontSize: 13,
  },
});
