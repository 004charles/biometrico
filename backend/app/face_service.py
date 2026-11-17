import os
import cv2
import numpy as np

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "models")

YUNET_PATH = os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx")
SFACE_PATH = os.path.join(MODELS_DIR, "face_recognition_sface_2021dec.onnx")

class FaceService:
    def __init__(self):
        self.detector = None
        self.recognizer = None
        self._init_models()

    def _init_models(self):
        if os.path.exists(YUNET_PATH) and os.path.exists(SFACE_PATH):
            try:
                self.detector = cv2.FaceDetectorYN.create(
                    model=YUNET_PATH,
                    config="",
                    input_size=(320, 320),
                    score_threshold=0.7,
                    nms_threshold=0.3,
                    top_k=5000
                )
                self.recognizer = cv2.FaceRecognizerSF.create(
                    model=SFACE_PATH,
                    config=""
                )
                print("✅ Modelos de reconhecimento facial (YuNet + SFace) carregados com sucesso.")
            except Exception as e:
                print(f"⚠️ Erro ao inicializar modelos de IA: {e}")
        else:
            print(f"⚠️ Modelos não encontrados em {MODELS_DIR}. Verificando fallback...")

    def decode_image(self, image_bytes: bytes):
        """Converte bytes de imagem para imagem OpenCV (BGR)."""
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        return img

    def extract_face_features(self, img):
        """Detecta o rosto e extrai o vetor biométrico (embedding) de 128 dimensões."""
        if self.detector is None or self.recognizer is None:
            self._init_models()
            if self.detector is None or self.recognizer is None:
                return None, "Modelos de IA não inicializados"

        h, w, _ = img.shape
        self.detector.setInputSize((w, h))
        _, faces = self.detector.detect(img)

        if faces is None or len(faces) == 0:
            return None, "Nenhum rosto detectado na imagem."

        # Pega o rosto com maior pontuação/área
        face = faces[0]
        aligned_face = self.recognizer.alignCrop(img, face)
        feature = self.recognizer.feature(aligned_face)

        return feature, None

    def compare_faces(self, feature1: np.ndarray, feature2: np.ndarray, threshold: float = 0.38):
        """
        Compara dois vetores de características com distância de cosseno.
        Retorna: (is_match: bool, similarity_score: float)
        """
        if self.recognizer is None:
            return False, 0.0

        # Cosine match:
        score = self.recognizer.match(feature1, feature2, cv2.FaceRecognizerSF_FR_COSINE)
        
        # Converter para float nativo
        score_val = float(score)
        is_match = score_val >= threshold

        return is_match, score_val

    def identify_employee(self, punch_feature: np.ndarray, employees_list: list, threshold: float = 0.38):
        """
        Busca 1:N (um para muitos): compara o rosto da câmara com TODOS os funcionários.
        Retorna: (best_employee, best_score)
        """
        best_emp = None
        best_score = -1.0

        for emp in employees_list:
            feat_blob = emp["face_features"]
            if not feat_blob:
                continue
            saved_feat = np.frombuffer(feat_blob, dtype=np.float32)
            _, score = self.compare_faces(saved_feat, punch_feature, threshold)

            if score > best_score:
                best_score = score
                if score >= threshold:
                    best_emp = emp

        return best_emp, best_score

face_service = FaceService()
