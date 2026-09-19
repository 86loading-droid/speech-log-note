"""
발화 기록 노트 — 목소리 복제 읽기 (무료 경로)

허깅페이스 Space 에 올려 쓰는 코드입니다. 학생 목소리를 참조로 받아
같은 목소리로 한국어 문장을 읽어 줍니다. XTTS-v2 를 씁니다.

무료 계정 기준
  - ZeroGPU Space 를 2개까지 만들 수 있습니다(이메일 인증, 가입 30일 경과 필요).
  - 하루 GPU 사용 시간 5분. 짧은 문장 한 번이 2~5초이므로 하루 60~150문장 수준입니다.
  - 한도를 넘기면 24시간 뒤 다시 채워집니다.

주의
  - XTTS-v2 모델은 CPML(비상업) 라이선스입니다. 교육·연구 용도에 적합합니다.
  - Space 설정에서 Hardware 를 ZeroGPU 로, Visibility 를 Private 로 두시길 권합니다.
    Private 로 두면 앱(중계 서버)이 보내는 토큰이 있어야만 호출됩니다.
"""

import os
import tempfile

import gradio as gr
import spaces
import torch

os.environ.setdefault("COQUI_TOS_AGREED", "1")

MODEL = "tts_models/multilingual/multi-dataset/xtts_v2"
MAX_CHARS = 200

_tts = None


def get_tts():
    global _tts
    if _tts is None:
        from TTS.api import TTS
        _tts = TTS(MODEL)
    return _tts


@spaces.GPU(duration=90)
def speak(ref_audio, text):
    """참조 음성과 글을 받아 같은 목소리로 읽은 소리를 돌려준다."""
    if not ref_audio:
        raise gr.Error("참조 음성이 없습니다.")
    text = (text or "").strip()
    if not text:
        raise gr.Error("읽을 내용이 없습니다.")
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS]

    tts = get_tts()
    tts.to("cuda" if torch.cuda.is_available() else "cpu")

    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    tts.tts_to_file(text=text, speaker_wav=ref_audio, language="ko", file_path=out)
    return out


with gr.Blocks(title="발화 기록 노트 — 목소리 복제 읽기") as demo:
    gr.Markdown(
        "## 발화 기록 노트 — 목소리 복제 읽기\n"
        "학생 목소리를 참조로 받아 같은 목소리로 한국어 문장을 읽어 줍니다.\n"
        "참조 음성은 10초 이상이면 실용적이고, 30초 이상이면 더 닮습니다."
    )
    with gr.Row():
        ref = gr.Audio(type="filepath", label="참조 음성")
        txt = gr.Textbox(label="읽을 글", lines=3, max_lines=6)
    btn = gr.Button("읽기", variant="primary")
    out = gr.Audio(type="filepath", label="복제 음성")
    btn.click(speak, [ref, txt], out, api_name="speak")

demo.queue(max_size=8).launch()
