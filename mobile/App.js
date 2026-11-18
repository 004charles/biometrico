import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator,
  FlatList, StatusBar, SafeAreaView,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

// Endereço do servidor (VPS). Mude aqui se o servidor mudar.
const SERVER_URL = "http://2.29.174.170:8000";
// Senha de administração (temporária). O servidor também a exige.
const ADMIN_CODE = "12345677654321";

const COLORS = {
  bg: "#f4f5f7", card: "#ffffff", ink: "#111827", mut: "#6b7280",
  line: "#e5e7eb", accent: "#1f2937", ok: "#15803d", bad: "#b91c1c",
};

export default function App() {
  const [screen, setScreen] = useState("punch");     // "punch" | "admin"
  const [code, setCode] = useState("");
  const [clock, setClock] = useState("");
  const [camera, setCamera] = useState(null);         // null | {action, emp?}
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);         // {ok, title, subtitle}
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    const t = setInterval(() => {
      setClock(new Date().toLocaleTimeString("pt-PT", { hour12: false }));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const press = (d) => setCode((c) => (c.length < 24 ? c + d : c));
  const backspace = () => setCode((c) => c.slice(0, -1));
  const clear = () => setCode("");

  const openCamera = useCallback(async (action, emp) => {
    if (!permission || !permission.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        setResult({ ok: false, title: "Câmara bloqueada", subtitle: "Autorize a câmara nas definições." });
        return;
      }
    }
    setCamera({ action, emp });
  }, [permission, requestPermission]);

  const onPicar = () => {
    const c = code.trim();
    if (c === ADMIN_CODE) { setCode(""); setScreen("admin"); return; }
    if (!c) { setResult({ ok: false, title: "Digite o seu código", subtitle: "Use o teclado abaixo." }); return; }
    openCamera("punch");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.bg} />
      {screen === "punch"
        ? <PunchScreen code={code} clock={clock} onDigit={press} onBack={backspace} onClear={clear} onPicar={onPicar} />
        : <AdminScreen onExit={() => setScreen("punch")} onEnroll={(emp) => openCamera("enroll", emp)} refreshKey={camera} />}

      {camera && (
        <CameraModal
          title={camera.action === "enroll" ? `Cadastrar rosto de ${camera.emp.name}` : "Olhe para a câmara"}
          onCancel={() => setCamera(null)}
          onCapture={async (photo) => {
            setCamera(null);
            setBusy(true);
            try {
              if (camera.action === "enroll") {
                const r = await enrollFace(camera.emp.id, photo);
                setResult(r.success
                  ? { ok: true, title: "Rosto cadastrado", subtitle: camera.emp.name }
                  : { ok: false, title: "Não deu para cadastrar", subtitle: r.message || "" });
              } else {
                const r = await punchFace(code.trim(), photo);
                if (r.success) {
                  setResult({ ok: true, title: `${r.type_label} registada`, subtitle: `${r.employee_name} • ${r.timestamp?.slice(11, 16)}` });
                  setCode("");
                } else {
                  setResult({ ok: false, title: "Não registado", subtitle: r.message || "" });
                }
              }
            } catch (e) {
              setResult({ ok: false, title: "Falha de ligação", subtitle: String(e.message || e) });
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {busy && (
        <View style={styles.overlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.overlayTxt}>A verificar…</Text>
        </View>
      )}

      {result && (
        <ResultOverlay result={result} onClose={() => setResult(null)} />
      )}
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ Picar */
function PunchScreen({ code, clock, onDigit, onBack, onClear, onPicar }) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "←"];
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Ponto por Reconhecimento Facial</Text>
        <Text style={styles.clock}>{clock}</Text>
      </View>

      <View style={styles.codeBox}>
        <Text style={styles.codeLabel}>O SEU CÓDIGO</Text>
        <Text style={styles.codeValue}>{code ? code : "—"}</Text>
      </View>

      <View style={styles.keypad}>
        {keys.map((k) => (
          <TouchableOpacity
            key={k}
            style={styles.key}
            onPress={() => (k === "C" ? onClear() : k === "←" ? onBack() : onDigit(k))}
          >
            <Text style={[styles.keyTxt, (k === "C" || k === "←") && { color: COLORS.mut }]}>{k}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.primaryBtn} onPress={onPicar} activeOpacity={0.85}>
        <Text style={styles.primaryTxt}>PICAR PONTO</Text>
      </TouchableOpacity>
    </View>
  );
}

/* ------------------------------------------------------------------ Admin */
function AdminScreen({ onExit, onEnroll, refreshKey }) {
  const [emps, setEmps] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/employees`);
      if (!res.ok) throw new Error("Erro ao carregar");
      setEmps(await res.json());
    } catch (e) { setErr(String(e.message || e)); setEmps([]); }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Cadastro de Rostos</Text>
        <TouchableOpacity onPress={onExit}><Text style={styles.link}>Sair</Text></TouchableOpacity>
      </View>
      {err ? <Text style={styles.errTxt}>{err}</Text> : null}
      {emps === null
        ? <ActivityIndicator style={{ marginTop: 40 }} color={COLORS.accent} />
        : (
          <FlatList
            data={emps}
            keyExtractor={(e) => String(e.id)}
            contentContainerStyle={{ paddingBottom: 24 }}
            renderItem={({ item }) => (
              <View style={styles.empRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.empName}>{item.name}</Text>
                  <Text style={styles.empMeta}>{item.code} • {item.department}</Text>
                </View>
                <View style={[styles.badge, item.has_face ? styles.badgeOk : styles.badgeOff]}>
                  <Text style={[styles.badgeTxt, { color: item.has_face ? COLORS.ok : COLORS.mut }]}>
                    {item.has_face ? "Com rosto" : "Sem rosto"}
                  </Text>
                </View>
                <TouchableOpacity style={styles.enrollBtn} onPress={() => onEnroll(item)}>
                  <Text style={styles.enrollTxt}>{item.has_face ? "Atualizar" : "Cadastrar"}</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.empMeta}>Nenhum colaborador. Sincronize no Humancore primeiro.</Text>}
          />
        )}
    </View>
  );
}

/* ------------------------------------------------------------------ Câmara */
function CameraModal({ title, onCapture, onCancel }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const [shooting, setShooting] = useState(false);

  const shoot = async () => {
    if (!ref.current || shooting) return;
    setShooting(true);
    try {
      const photo = await ref.current.takePictureAsync({ quality: 0.6, skipProcessing: false });
      onCapture(photo);
    } catch (e) {
      setShooting(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={styles.camWrap}>
        <CameraView ref={ref} style={{ flex: 1 }} facing="front" onCameraReady={() => setReady(true)} />
        <View style={styles.camBar}>
          <Text style={styles.camTitle}>{title}</Text>
          <View style={styles.camActions}>
            <TouchableOpacity style={styles.camCancel} onPress={onCancel}>
              <Text style={styles.camCancelTxt}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.camShoot, (!ready || shooting) && { opacity: 0.5 }]} onPress={shoot} disabled={!ready || shooting}>
              <Text style={styles.camShootTxt}>{shooting ? "…" : "Capturar"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/* --------------------------------------------------------------- Resultado */
function ResultOverlay({ result, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  const color = result.ok ? COLORS.ok : COLORS.bad;
  return (
    <TouchableOpacity activeOpacity={1} style={styles.resultWrap} onPress={onClose}>
      <View style={[styles.resultCard, { borderColor: color }]}>
        <View style={[styles.resultMark, { backgroundColor: color }]}>
          <Text style={styles.resultMarkTxt}>{result.ok ? "✓" : "✕"}</Text>
        </View>
        <Text style={[styles.resultTitle, { color }]}>{result.title}</Text>
        {!!result.subtitle && <Text style={styles.resultSub}>{result.subtitle}</Text>}
      </View>
    </TouchableOpacity>
  );
}

/* --------------------------------------------------------------- Servidor */
function photoPart(photo) {
  const uri = photo.uri;
  const name = (uri.split("/").pop() || "foto.jpg").split("?")[0];
  return { uri, name: name.endsWith(".jpg") ? name : "foto.jpg", type: "image/jpeg" };
}

async function punchFace(code, photo) {
  const form = new FormData();
  form.append("employee_code", code);
  form.append("photo", photoPart(photo));
  const res = await fetch(`${SERVER_URL}/api/attendance/punch-face`, {
    method: "POST", body: form, headers: { Accept: "application/json" },
  });
  return res.json();
}

async function enrollFace(empId, photo) {
  const form = new FormData();
  form.append("photo", photoPart(photo));
  const res = await fetch(`${SERVER_URL}/api/employees/${empId}/enroll-face`, {
    method: "POST", body: form, headers: { Accept: "application/json", "X-Admin-Code": ADMIN_CODE },
  });
  return res.json();
}

/* ----------------------------------------------------------------- Estilos */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  container: { flex: 1, padding: 20 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 18 },
  title: { fontSize: 16, fontWeight: "700", color: COLORS.ink, flex: 1 },
  clock: { fontSize: 18, fontWeight: "700", color: COLORS.ink, fontVariant: ["tabular-nums"] },
  link: { color: COLORS.mut, fontWeight: "700", fontSize: 14 },

  codeBox: { backgroundColor: COLORS.card, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, paddingVertical: 22, alignItems: "center", marginBottom: 18 },
  codeLabel: { fontSize: 11, letterSpacing: 1.5, color: COLORS.mut, fontWeight: "700" },
  codeValue: { fontSize: 34, fontWeight: "800", color: COLORS.ink, marginTop: 6, letterSpacing: 2 },

  keypad: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  key: { width: "31.5%", aspectRatio: 1.9, backgroundColor: COLORS.card, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  keyTxt: { fontSize: 26, fontWeight: "700", color: COLORS.ink },

  primaryBtn: { backgroundColor: COLORS.accent, borderRadius: 16, paddingVertical: 20, alignItems: "center", marginTop: "auto" },
  primaryTxt: { color: "#fff", fontSize: 18, fontWeight: "800", letterSpacing: 1 },

  empRow: { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.card, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 14, marginBottom: 10 },
  empName: { fontSize: 15, fontWeight: "700", color: COLORS.ink },
  empMeta: { fontSize: 12, color: COLORS.mut, marginTop: 2 },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, marginRight: 10 },
  badgeOk: { backgroundColor: "#dcfce7" }, badgeOff: { backgroundColor: "#f3f4f6" },
  badgeTxt: { fontSize: 11, fontWeight: "700" },
  enrollBtn: { backgroundColor: COLORS.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  enrollTxt: { color: "#fff", fontWeight: "700", fontSize: 13 },
  errTxt: { color: COLORS.bad, marginBottom: 10 },

  camWrap: { flex: 1, backgroundColor: "#000" },
  camBar: { padding: 20, backgroundColor: "#000" },
  camTitle: { color: "#fff", fontSize: 15, fontWeight: "600", textAlign: "center", marginBottom: 14 },
  camActions: { flexDirection: "row", justifyContent: "space-between" },
  camCancel: { paddingVertical: 16, paddingHorizontal: 24, borderRadius: 14, borderWidth: 1, borderColor: "#374151" },
  camCancelTxt: { color: "#d1d5db", fontWeight: "700", fontSize: 15 },
  camShoot: { flex: 1, marginLeft: 12, backgroundColor: "#fff", borderRadius: 14, alignItems: "center", justifyContent: "center" },
  camShootTxt: { color: "#111", fontWeight: "800", fontSize: 16 },

  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  overlayTxt: { color: "#fff", marginTop: 12, fontSize: 15, fontWeight: "600" },

  resultWrap: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(17,24,39,0.55)", alignItems: "center", justifyContent: "center", padding: 28 },
  resultCard: { backgroundColor: "#fff", borderRadius: 22, borderTopWidth: 6, paddingVertical: 34, paddingHorizontal: 28, alignItems: "center", width: "100%", maxWidth: 360 },
  resultMark: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  resultMarkTxt: { color: "#fff", fontSize: 40, fontWeight: "800" },
  resultTitle: { fontSize: 20, fontWeight: "800", textAlign: "center" },
  resultSub: { fontSize: 15, color: COLORS.mut, marginTop: 6, textAlign: "center" },
});
