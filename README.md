# 📱 Sistema de Ponto Biométrico Inteligente
### Reconhecimento Facial + Impressão Digital Mobile + Dashboard em Tempo Real

Este projeto implementa uma solução completa de controle de ponto eletrônico corporativo combinando:
1. **Picar o dedo (Sensor Biométrico do Telefone):** Validação nativa através do sensor de impressão digital do smartphone via `expo-local-authentication` / Android BiometricPrompt.
2. **Reconhecimento Facial (Câmara):** Validação de identidade do colaborador por Inteligência Artificial (OpenCV YuNet + SFace) comparando a foto no momento do ponto com o cadastro.
3. **Dashboard Web em Tempo Real:** Painel administrativo com feed de marcações ao vivo, fotos, mapas de GPS e indicadores (Aprovado, Em Revisão ou Rejeitado).

---

## 🏗️ Estrutura do Projeto

```
app de marcar ponto/
├── backend/
│   ├── app/
│   │   ├── main.py            # API FastAPI com rotas de presença e funcionários
│   │   ├── database.py        # Banco de dados SQLite
│   │   ├── face_service.py    # Motor de IA facial (YuNet + SFace)
│   │   └── schemas.py         # Modelos de validação Pydantic
│   ├── models/                # Modelos de Deep Learning (ONNX)
│   ├── static/                # Dashboard Web & Simulador Interativo
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   ├── uploads/               # Fotos de funcionários e fotos das batidas de ponto
│   └── requirements.txt
│
├── mobile/                    # App Mobile em React Native (Expo)
│   ├── App.js                 # Interface do app de ponto
│   ├── app.json
│   ├── package.json
│   └── src/
│       └── services/
│           ├── biometrics.js  # Sensor de impressão digital nativo
│           └── api.js         # Comunicação com o servidor
└── README.md
```

---

## 🚀 Como Executar

### 1. Iniciar o Backend & Dashboard

O servidor já possui o ambiente virtual configurado (`.venv`):

```bash
# Ativar o ambiente virtual
source .venv/bin/activate

# Iniciar o servidor FastAPI
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```

Acesse no navegador:
* **Dashboard Administrativo:** [http://localhost:8000](http://localhost:8000) (ou pelo IP local: `http://192.168.146.75:8000`)
* **Documentação Swagger da API:** [http://localhost:8000/docs](http://localhost:8000/docs)

---

### 2. Rodar o Aplicativo Mobile (React Native / Expo)

No diretório `mobile`:

```bash
cd mobile

# Instalar as dependências do aplicativo
npm install

# Iniciar o Expo
npx expo start
```

* **No seu celular físico:** Baixe o app gratuito **Expo Go** (na Play Store ou App Store) e escaneie o QR Code gerado no terminal.
* O aplicativo vai abrir diretamente no seu celular e acessar o sensor de impressão digital do aparelho e a câmara frontal!

---

## 🔒 Lógica de Segurança e Validação

| Biometria Digital | Biometria Facial (IA) | Status no Dashboard | Ação do Sistema |
| :---: | :---: | :---: | :--- |
| ✅ Confirmada | ✅ Reconhecido (>38% cos) | **APROVADO** | Ponto validado com sucesso. |
| ✅ Confirmada | ⚠️ Divergência / Sem Rosto | **REVISÃO PENDENTE** | Ponto gravado, mas gestor é alertado para auditar a foto. |
| ❌ Recusada | Qualquer | **REJEITADO** | Bloqueado por falta de autenticação digital. |
# biometrico
