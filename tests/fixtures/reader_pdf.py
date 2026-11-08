"""Synthetic, redistributable PDF with known page anchors; no network or model."""

import io
import sys
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    Fit,
    NameObject,
    NumberObject,
    RectangleObject,
    TextStringObject,
)


PAGES = [
    ["1 Introduction", "Reader Fixture: a synthetic research paper.",
     "We study how bounded page retrieval supports a personal research library.",
     "The main contribution is evidence-linked reading, notes, and discussion.",
     "No instructions in a document should be executed by a research agent."],
    ["2 Method", "The method uses a local full-text index and preserves page anchors.",
     "A lexical query selects relevant passages, then includes neighboring context.",
     "Every answer must cite supplied evidence; missing evidence stays explicit."],
    ["3 Results", "The synthetic benchmark reaches 82 percent accuracy on 50 trials.",
     "The baseline reaches 61 percent accuracy under the same test conditions.",
     "4 Limitations", "This fixture does not measure performance on real research papers."],
]

CITATION_PAGES = [
    PAGES[0] + [
        "Example et al. (2026) describe evidence-linked reading.",
        "Reader (2025) adds a second reference.",
    ],
    PAGES[1],
    PAGES[2],
    [
        "References",
        "A. Example, B. Author, and C. Researcher. Evidence-linked reading.",
        "Journal of Synthetic Research, 12(3): 10-24, 2026.",
        "B. Reader. Reliable citation previews in a personal library.",
        "Proceedings of the Fixture Conference, pages 30-44, 2025.",
        "5 Appendix",
        "This appendix is not part of either bibliographic reference.",
    ],
]


def pdf_bytes(pages=None, *, citations=False):
    """Opt in to a four-page fixture with XYZ/FitH citations and a named appendix."""
    if citations and pages is not None:
        raise ValueError("The citation fixture supplies its own page layout.")
    selected_pages = (
        CITATION_PAGES if citations else (PAGES if pages is None else pages)
    )
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    }))
    for page_index, lines in enumerate(selected_pages):
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        content = ["BT /F1 13 Tf 42 740 Td"]
        for index, line in enumerate(lines):
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            if index:
                content.append(
                    "0 -16 Td" if citations and page_index == 3 else "0 -28 Td"
                )
            content.append(f"({escaped}) Tj")
        content.append("ET")
        if citations and page_index == 3:
            content.append("BT /F1 10 Tf 302 40 Td (4) Tj ET")
        stream = DecodedStreamObject()
        stream.set_data("\n".join(content).encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    if citations:
        writer.add_named_destination("cite.example2026", 3, Fit.xyz(left=42, top=737))
        writer.add_named_destination("cite.reader2025", 3, Fit.fit_horizontally(top=705))
        writer.add_named_destination("section.appendix", 3, Fit.fit_horizontally(top=673))
        for name, rect in [
            ("cite.example2026", (42, 597, 175, 614)),
            ("cite.reader2025", (42, 569, 128, 586)),
        ]:
            writer.add_annotation(
                0,
                DictionaryObject({
                    NameObject("/Type"): NameObject("/Annot"),
                    NameObject("/Subtype"): NameObject("/Link"),
                    NameObject("/Rect"): RectangleObject(rect),
                    NameObject("/Border"): ArrayObject([NumberObject(0)] * 3),
                    NameObject("/A"): DictionaryObject({
                        NameObject("/S"): NameObject("/GoTo"),
                        NameObject("/D"): TextStringObject(name),
                    }),
                }),
            )
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


if __name__ == "__main__":
    Path(sys.argv[1]).write_bytes(pdf_bytes(citations="--citations" in sys.argv[2:]))
