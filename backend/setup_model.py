"""음성인식 모델(large-v3-turbo, 약 1.6GB)을 models/ 폴더에 내려받는다. 이미 있으면 건너뛴다.

설치.bat이 실행한다. 영상은 전송하지 않고, 모델 파일만 한 번 내려받는다.
"""
import sys

from backend.core.stt import MODEL_DIR


def main() -> int:
    if (MODEL_DIR / "model.bin").is_file():
        print(f"음성인식 모델이 이미 있습니다: {MODEL_DIR}")
        return 0
    print("음성인식 모델을 내려받는 중입니다 (약 1.6GB, 인터넷 속도에 따라 1~10분)...")
    from faster_whisper.utils import download_model

    download_model("large-v3-turbo", output_dir=str(MODEL_DIR))
    ok = (MODEL_DIR / "model.bin").is_file()
    print("모델 준비 완료" if ok else "모델 내려받기 실패")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
