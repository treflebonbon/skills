#!/usr/bin/env python3
"""Check Mermaid source markup in an architecture HTML report."""

import html.parser
import json
from pathlib import Path
import sys


class ReportParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.expected_diagrams = 0
        self.in_mermaid_pre = False
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if self.in_mermaid_pre:
            self.errors.append(f"Mermaid の <pre> 内に <{tag}> markup があります")
        elif tag == "pre" and "mermaid" in (dict(attrs).get("class") or "").split():
            self.expected_diagrams += 1
            self.in_mermaid_pre = True

    def handle_startendtag(self, tag, attrs):
        if self.in_mermaid_pre:
            self.errors.append(f"Mermaid の <pre> 内に <{tag}/> markup があります")
        elif tag == "pre" and "mermaid" in (dict(attrs).get("class") or "").split():
            self.expected_diagrams += 1
            self.errors.append("Mermaid の <pre> が self-closing です")

    def handle_endtag(self, tag):
        if not self.in_mermaid_pre:
            return
        if tag == "pre":
            self.in_mermaid_pre = False
        else:
            self.errors.append(f"Mermaid の <pre> 内に </{tag}> markup があります")

    def handle_comment(self, data):
        if self.in_mermaid_pre:
            self.errors.append("Mermaid の <pre> 内に HTML comment があります")

    def handle_decl(self, decl):
        if self.in_mermaid_pre:
            self.errors.append("Mermaid の <pre> 内に HTML declaration があります")

    unknown_decl = handle_decl

    def handle_pi(self, data):
        if self.in_mermaid_pre:
            self.errors.append("Mermaid の <pre> 内に processing instruction があります")


def inspect_report(path):
    try:
        source = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise ValueError("HTML report を UTF-8 で読めません") from None

    parser = ReportParser()
    parser.feed(source)
    parser.close()
    if parser.in_mermaid_pre:
        parser.errors.append("Mermaid の <pre> が閉じていません")
    if parser.errors:
        raise ValueError("; ".join(parser.errors))
    return parser.expected_diagrams


def main(argv):
    if len(argv) != 2:
        raise ValueError("使い方: check-architecture-report.py <report.html>")
    expected = inspect_report(argv[1])
    print(json.dumps({
        "static_check": "passed",
        "expected_mermaid_diagrams": expected,
        "render_check": "not_performed",
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main(sys.argv)
    except ValueError as error:
        print(f"エラー: {error}", file=sys.stderr)
        sys.exit(1)
