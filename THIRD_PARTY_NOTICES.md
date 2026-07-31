# Third-party notices and licensing scope

The MIT License in [`LICENSE`](LICENSE) applies only to original source code and
documentation for which Poneglyph contributors hold the necessary rights. It
does not relicense third-party material included, downloaded, processed, or
referenced by this project.

Unless a separate license explicitly says otherwise, the following are not
covered by the Poneglyph MIT License:

- manga, comic, and book scans, page images, extracts, and related metadata;
- imported or generated datasets and annotations derived from protected works;
- third-party machine-learning models, configuration files, tokenizers, and
  model weights;
- third-party fonts, artwork, icons, logos, and other brand assets; and
- product names, character names, company names, and trademarks belonging to
  their respective owners.

Users and distributors are responsible for obtaining any rights required for
those materials and for complying with the terms attached to each source.

## Software dependencies

Poneglyph uses third-party open-source packages. Each package remains subject
to its own license and copyright notices. The authoritative dependency lists
and resolved versions are recorded in:

- `frontend/package.json` and `frontend/package-lock.json` for the web client;
- `backend/package.json` and `backend/package-lock.json` for the API;
- `frontend/src-tauri/Cargo.toml` and `frontend/src-tauri/Cargo.lock` for the
  desktop shell; and
- the repository's Python `requirements.txt` files for local inference and
  training tools.

The copied ONNX Runtime Web distribution under `frontend/public/onnx/` is a
third-party component from Microsoft. Its license and notices are available in
the upstream ONNX Runtime distribution:
<https://github.com/microsoft/onnxruntime>.

Binary distributions must retain every license or notice required by their
included dependencies. Package metadata and upstream distributions take
precedence over this summary if they differ.

## Machine-learning models

Model artifacts are downloaded separately and are not distributed under the
Poneglyph MIT License. This includes, without limitation:

- `Remidesbois/LightonOCR-2-1b-poneglyph-bbox`;
- `Remidesbois/LightonOCR-2-1b-poneglyph`;
- `Remidesbois/surya-ocr-2-poneglyph-bbox`;
- `Remidesbois/surya-bubble-ocr-poneglyph`;
- `Remidesbois/pp-ocrv6-one-piece-bubble-line-rec`; and
- `Remidesbois/YoloPiece_OneShot_Models`.

The license, acceptable-use terms, and notices shown on each model repository
and on its base model govern use of those artifacts. A Poneglyph source-code
license does not grant rights to a base model or its weights.

## Project assets and user-provided content

The Poneglyph name and project-specific branding are not granted as trademarks
by the MIT License. The file `frontend/public/fonts/poneglyph.woff2`, visual
assets, and user-provided content must not be assumed to be MIT-licensed unless
an adjacent notice or their documented source grants that permission.

This notice is intended to make the licensing boundary explicit; it is not a
substitute for the license text and attribution files shipped by third parties.
