"""
Export presentation/index.html to PDF using headless Chrome or Microsoft Edge.
Usage:
    python presentation/export_pdf.py
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_browser_executable() -> str:
    """Find Google Chrome or Microsoft Edge executable path."""
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]

    for path in candidates:
        if os.path.isfile(path):
            return path

    # Check PATH
    for name in ["chrome", "google-chrome", "msedge", "edge"]:
        found = shutil.which(name)
        if found:
            return found

    raise FileNotFoundError(
        "Could not find Google Chrome or Microsoft Edge executable on this system."
    )


def export_pdf(html_path: Path, output_pdf_path: Path) -> None:
    """Compile HTML document into PDF using headless browser."""
    browser_exe = find_browser_executable()
    print(f"Using browser: {browser_exe}")

    abs_html = html_path.resolve()
    abs_output = output_pdf_path.resolve()

    if not abs_html.is_file():
        raise FileNotFoundError(f"Source HTML file not found: {abs_html}")

    # Prepare environment (remove proxies that may block local headless navigation)
    env = dict(os.environ)
    env.pop("HTTP_PROXY", None)
    env.pop("http_proxy", None)
    env.pop("HTTPS_PROXY", None)
    env.pop("https_proxy", None)

    temp_pdf = abs_output.parent / f"temp_{abs_output.name}"

    cmd = [
        browser_exe,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={temp_pdf}",
        str(abs_html),
    ]

    print(f"Generating PDF: {abs_html} -> {abs_output}")
    res = subprocess.run(cmd, env=env, capture_output=True, text=True)

    if res.returncode != 0:
        print(f"Browser process returned code {res.returncode}")
        print("Browser stderr:", res.stderr)

    if not temp_pdf.is_file() or temp_pdf.stat().st_size == 0:
        raise RuntimeError("Failed to generate PDF file via headless browser.")

    # Move temp PDF to final output path
    shutil.move(str(temp_pdf), str(abs_output))
    print(f"PDF successfully created at: {abs_output} ({abs_output.stat().st_size:,} bytes)")


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent

    # Document 1: Master Executive & Business Strategy Report
    report_html = script_dir / "index.html"
    report_pdf = project_root / "BAO_CAO_DE_AN_AI_ECOMMERCE_3_MODULE.pdf"
    export_pdf(report_html, report_pdf)

    # Document 2: In-depth Technical Specification Blueprint
    spec_html = script_dir / "tech_spec.html"
    spec_pdf = project_root / "DAC_TA_KY_THUAT_HE_THONG_AI_AGENT.pdf"
    if spec_html.is_file():
        export_pdf(spec_html, spec_pdf)


if __name__ == "__main__":
    main()
