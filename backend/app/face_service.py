"""Motor de reconhecimento facial (YuNet para detetar + SFace para comparar).

Usado em dois momentos:
  - Cadastro: guardamos o "mapa" da cara de cada colaborador (um vetor de números).
  - Picagem (código + cara): comparamos a foto do momento com o mapa guardado dessa pessoa.

Nota: quando há mais do que uma cara na imagem (gente a passar atrás), usamos sempre
a MAIOR cara — a da pessoa que está à frente da câmara.
"""
import os

# OpenCV/numpy são opcionais: se faltarem, o reconhecimento facial fica indisponível,
# mas o resto do sistema (dashboard, Humancore, picagem por código) continua a funcionar.
try:
    import cv2
    import numpy as np
    _CV_OK = True
except Exception as _e:  # pragma: no cover
    cv2 = None
    np = None
    _CV_OK = False
    print(f"⚠️ OpenCV/numpy indisponível — reconhecimento facial desligado: {_e}")

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "models")

YUNET_PATH = os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx")
SFACE_PATH = os.path.join(MODELS_DIR, "face_recognition_sface_2021dec.onnx")

# Marca de acerto (semelhança de cosseno do SFace). Testado: mesma pessoa >0.90,
# pessoas diferentes ~0.13. 0.38 é o valor recomendado pelos autores do modelo.
MATCH_THRESHOLD = float(os.environ.get("FACE_THRESHOLD", "0.38"))
# A maior cara tem de ocupar pelo menos esta fração da largura da imagem (evita
# aceitar alguém distante em vez de quem está à frente do terminal).
MIN_FACE_WIDTH_RATIO = float(os.environ.get("FACE_MIN_WIDTH_RATIO", "0.12"))


class FaceService:
    def __init__(self):
        self.detector = None
        self.recognizer = None
        self._init_models()

    def _init_models(self):
        if not _CV_OK:
            return
        if os.path.exists(YUNET_PATH) and os.path.exists(SFACE_PATH):
            try:
                self.detector = cv2.FaceDetectorYN.create(
                    model=YUNET_PATH, config="", input_size=(320, 320),
                    score_threshold=0.7, nms_threshold=0.3, top_k=5000,
                )
                self.recognizer = cv2.FaceRecognizerSF.create(model=SFACE_PATH, config="")
                print("✅ Modelos de reconhecimento facial (YuNet + SFace) carregados com sucesso.")
            except Exception as e:
                print(f"⚠️ Erro ao inicializar modelos de IA: {e}")
        else:
            print(f"⚠️ Modelos de IA não encontrados em {MODELS_DIR}.")

    @property
    def ready(self) -> bool:
        if not _CV_OK:
            return False
        if self.detector is None or self.recognizer is None:
            self._init_models()
        return self.detector is not None and self.recognizer is not None

    def decode_image(self, image_bytes: bytes):
        """Bytes de imagem -> imagem OpenCV (BGR), ou None se não for uma imagem válida."""
        if not image_bytes:
            return None
        nparr = np.frombuffer(image_bytes, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    def _detect_main_face(self, img):
        """Deteta e devolve a MAIOR cara da imagem: (face, erro)."""
        h, w = img.shape[:2]
        self.detector.setInputSize((w, h))
        _, faces = self.detector.detect(img)
        if faces is None or len(faces) == 0:
            return None, "Nenhum rosto detetado na imagem."
        # Escolhe a maior cara (largura*altura), que é a da pessoa mais próxima.
        main = max(faces, key=lambda f: float(f[2]) * float(f[3]))
        if float(main[2]) < MIN_FACE_WIDTH_RATIO * w:
            return None, "Aproxime-se da câmara: o rosto está demasiado pequeno/distante."
        return main, None

    def extract_face_features(self, img):
        """Deteta a cara principal e extrai o vetor biométrico. Devolve (feature, erro)."""
        if not self.ready:
            return None, "Modelos de IA não inicializados."
        if img is None:
            return None, "Imagem inválida."
        face, err = self._detect_main_face(img)
        if err:
            return None, err
        aligned = self.recognizer.alignCrop(img, face)
        return self.recognizer.feature(aligned), None

    def features_from_bytes(self, image_bytes: bytes):
        """Bytes de imagem -> (feature, erro). Usado nas rotas HTTP."""
        if not self.ready:
            return None, "Reconhecimento facial indisponível no servidor (OpenCV/modelos em falta)."
        img = self.decode_image(image_bytes)
        if img is None:
            return None, "Ficheiro de imagem inválido ou corrompido."
        return self.extract_face_features(img)

    @staticmethod
    def to_blob(feature) -> bytes:
        """Vetor -> bytes, para guardar na base de dados."""
        return np.asarray(feature, dtype=np.float32).tobytes()

    @staticmethod
    def from_blob(blob: bytes):
        """Bytes guardados -> vetor (forma 1xN, como o SFace espera)."""
        return np.frombuffer(blob, dtype=np.float32).reshape(1, -1)

    def compare_faces(self, feature1, feature2, threshold: float = MATCH_THRESHOLD):
        """Compara dois vetores. Devolve (é_a_mesma_pessoa, semelhança 0..1)."""
        if not self.ready:
            return False, 0.0
        score = float(self.recognizer.match(feature1, feature2, cv2.FaceRecognizerSF_FR_COSINE))
        return score >= threshold, score

    def verify(self, image_bytes: bytes, stored_blob: bytes, threshold: float = MATCH_THRESHOLD):
        """Verificação 1:1 (código + cara). Devolve (ok, semelhança, erro)."""
        feature, err = self.features_from_bytes(image_bytes)
        if err:
            return False, 0.0, err
        match, score = self.compare_faces(self.from_blob(stored_blob), feature, threshold)
        if not match:
            return False, score, "A cara não corresponde ao código indicado."
        return True, score, None

    def identify_employee(self, punch_feature, employees_list, threshold: float = MATCH_THRESHOLD):
        """Busca 1:N: compara com TODOS os colaboradores. Devolve (melhor, semelhança)."""
        best_emp, best_score = None, -1.0
        for emp in employees_list:
            blob = emp["face_features"]
            if not blob:
                continue
            _, score = self.compare_faces(self.from_blob(blob), punch_feature, threshold)
            if score > best_score:
                best_score = score
                if score >= threshold:
                    best_emp = emp
        return best_emp, best_score


face_service = FaceService()
