import base64
import sys
import unittest
from pathlib import Path
from unittest import mock

from pydantic import ValidationError

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import local_ocr_server as server


class OcrRequestValidationTests(unittest.TestCase):
    def test_request_rejects_empty_oversized_and_unknown_fields(self):
        with self.assertRaises(ValidationError):
            server.OcrRequest(image_bytes_base64="")

        with self.assertRaises(ValidationError):
            server.OcrRequest(
                image_bytes_base64="A" * (server.MAX_IMAGE_BASE64_CHARS + 1)
            )

        with self.assertRaises(ValidationError):
            server.OcrRequest(image_bytes_base64="aGVsbG8=", unexpected=True)

    def test_decoder_rejects_invalid_base64_and_decoded_size_overflow(self):
        invalid = server.decode_image_request(
            server.OcrRequest(image_bytes_base64="!!!!")
        )
        self.assertEqual(invalid.status_code, 400)

        encoded = base64.b64encode(b"abc").decode("ascii")
        with mock.patch.object(server, "MAX_IMAGE_BYTES", 2):
            oversized = server.decode_image_request(
                server.OcrRequest(image_bytes_base64=encoded)
            )
        self.assertEqual(oversized.status_code, 413)

    def test_decoder_accepts_valid_bounded_payload(self):
        encoded = base64.b64encode(b"image").decode("ascii")
        decoded = server.decode_image_request(
            server.OcrRequest(image_bytes_base64=encoded)
        )
        self.assertEqual(decoded, b"image")


if __name__ == "__main__":
    unittest.main()
