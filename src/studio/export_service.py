"""Book-style export helpers for HTML, EPUB, and PDF formats."""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from django.conf import settings
from django.utils.html import strip_tags

if TYPE_CHECKING:
    from .models import FrontBackMatter, Project

FRONT_MATTER_TYPES = {"dedication", "preface", "foreword", "prologue"}
BACK_MATTER_TYPES = {"epilogue", "afterword", "appendix", "acknowledgments", "author_note"}

BOOK_CSS = """\
@charset "UTF-8";

/* ── Page layout ── */
@page {
    size: 6in 9in;
    margin: 1in 0.85in 1.1in 0.85in;

    @top-center {
        content: string(chapter-title);
        font-family: "Georgia", "Times New Roman", serif;
        font-size: 8.5pt;
        color: #aaa;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }
    @bottom-center {
        content: counter(page);
        font-family: "Georgia", "Times New Roman", serif;
        font-size: 9pt;
        color: #888;
    }
}

@page :first {
    margin: 1.2in 0.85in 1.2in 0.85in;
    @top-center    { content: none; }
    @bottom-center { content: none; }
}

@page chapter-first {
    @top-center    { content: none; }
    @bottom-center { content: counter(page); }
}

@page front-matter {
    @top-center    { content: none; }
    @bottom-center { content: none; }
}

@media print {
    html, body { margin: 0; padding: 0; }
}

/* ── Base ── */
*, *::before, *::after { box-sizing: border-box; }

html { font-size: 11pt; }

body {
    font-family: "Georgia", "Times New Roman", "Garamond", serif;
    font-size: 1rem;
    line-height: 1.75;
    color: #1a1a1a;
    background: #fff;
    margin: 0;
    padding: 0;
}

/* ── Title page ── */
.title-page {
    page: first-page;
    text-align: center;
    page-break-after: always;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 100vh;
    padding: 15vh 2em;
}

.title-page h1 {
    font-size: 2.4rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin: 0 0 0.4em;
    line-height: 1.15;
    color: #111;
}

.title-page .author {
    font-size: 1.05rem;
    font-weight: 400;
    color: #555;
    margin: 0.3em 0 1.5em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.title-page .logline {
    font-style: italic;
    font-size: 1rem;
    color: #666;
    max-width: 26em;
    margin: 0 auto;
    line-height: 1.65;
}

.title-page .ornament {
    display: block;
    margin: 2em auto 1em;
    font-size: 1.1rem;
    color: #bbb;
    letter-spacing: 0.45em;
}

/* ── Front / back matter ── */
.front-matter,
.back-matter {
    page: front-matter;
    page-break-before: always;
}

.front-matter h2,
.back-matter h2 {
    font-size: 1.35rem;
    font-weight: 600;
    text-align: center;
    margin: 3.5em 0 1.5em;
    letter-spacing: 0.04em;
    color: #222;
    string-set: chapter-title content(text);
}

.section-body {
    text-align: justify;
    hyphens: auto;
}

.section-body p {
    margin: 0;
    text-indent: 1.5em;
}

.section-body p:first-child { text-indent: 0; }

/* ── Chapters ── */
.chapter {
    page-break-before: always;
}

.chapter-header {
    page: chapter-first;
    text-align: center;
    padding: 5em 0 3em;
}

.chapter-number {
    display: block;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: #aaa;
    margin-bottom: 0.5em;
}

.chapter-header h2 {
    font-size: 1.7rem;
    font-weight: 700;
    margin: 0;
    color: #111;
    letter-spacing: 0.01em;
    string-set: chapter-title content(text);
}

.chapter-header .chapter-ornament {
    display: block;
    margin-top: 1.3em;
    font-size: 0.85rem;
    color: #ccc;
    letter-spacing: 0.55em;
}

.chapter-body {
    text-align: justify;
    hyphens: auto;
}

.chapter-body p {
    margin: 0;
    text-indent: 1.5em;
}

.chapter-body p:first-child { text-indent: 0; }

.chapter-body p + p { text-indent: 1.5em; }

.chapter-body img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1.8em auto;
    page-break-inside: avoid;
}

/* ── Section break ── */
.scene-break {
    text-align: center;
    margin: 2em 0;
    color: #bbb;
    font-size: 0.85rem;
    letter-spacing: 0.4em;
}

/* ── Misc ── */
hr {
    border: none;
    text-align: center;
    margin: 2.2em 0;
}

hr::after {
    content: "\\2022\\2002\\2022\\2002\\2022";
    color: #ccc;
    font-size: 0.78rem;
    letter-spacing: 0.35em;
}

blockquote {
    margin: 1.5em 2em;
    padding-left: 1em;
    border-left: 2px solid #ddd;
    font-style: italic;
    color: #444;
}

/* ── Cover page ── */
.cover-page {
    page: cover;
    page-break-after: always;
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
}

.cover-page--full {
    padding: 0;
}

.cover-full-img,
.cover-bg-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.cover-overlay {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.5) 100%);
    padding: 1.5in;
    box-sizing: border-box;
}

.cover-title-text {
    font-family: "Georgia", serif;
    font-size: 32pt;
    font-weight: bold;
    color: #fff;
    text-align: center;
    margin-bottom: 0.3in;
    text-shadow: 0 2px 8px rgba(0,0,0,0.7);
}

.cover-author-text {
    font-family: "Arial", sans-serif;
    font-size: 12pt;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #ddd;
    text-align: center;
    text-shadow: 0 1px 4px rgba(0,0,0,0.6);
}

@page cover {
    margin: 0;
}
"""

SCREEN_PREVIEW_CSS = """\
@media screen {
    html {
        font-size: 13pt;
        background:
            radial-gradient(circle at top, rgba(196, 154, 108, 0.1), transparent 28%),
            #e8e1d7;
    }

    body {
        background: transparent;
        padding: 2rem 1.4rem 3rem;
    }

    .cover-page,
    .title-page,
    .front-matter,
    .back-matter,
    .chapter {
        width: min(100%, 7.2in);
        margin: 0 auto 1.8rem;
        background: #fff;
        box-shadow: 0 28px 60px rgba(28, 23, 18, 0.18);
        border: 1px solid rgba(56, 44, 33, 0.08);
        overflow: hidden;
    }

    .cover-page,
    .title-page {
        min-height: 9.35in;
    }

    .front-matter,
    .back-matter,
    .chapter {
        min-height: 9.35in;
        padding: 0.95in 0.82in 1.05in;
    }

    .title-page {
        padding: 2.4in 0.95in 2in;
    }

    .chapter-header {
        padding: 1.8em 0 2.2em;
    }

    .cover-overlay {
        padding: 1.2in;
    }

    .cover-title-text {
        font-size: 2.5rem;
        margin-bottom: 0.35in;
    }

    .cover-author-text {
        font-size: 0.95rem;
    }
}
"""


@dataclass
class _BookData:
    title: str
    author: str
    logline: str
    cover_editor_mode: str = "generated"
    rendered_cover_url: str = ""
    custom_cover_url: str = ""
    cover_image_url: str = ""
    cover_bg_color: str = "#1a1a2e"
    cover_title_text: str = ""
    cover_author_text: str = ""
    cover_display_mode: str = "artwork"
    front_matter: list[dict] = field(default_factory=list)
    chapters: list[dict] = field(default_factory=list)
    back_matter: list[dict] = field(default_factory=list)


def _gather_book_data(project: Project) -> _BookData:
    profile = project.user.profile
    author = profile.pen_name or project.user.get_full_name() or project.user.username

    front: list[FrontBackMatter] = list(
        project.front_back_matter.filter(section_type__in=FRONT_MATTER_TYPES).order_by("position")
    )
    back: list[FrontBackMatter] = list(
        project.front_back_matter.filter(section_type__in=BACK_MATTER_TYPES).order_by("position")
    )

    # Cover design
    cover_editor_mode = "generated"
    cover_image_url = ""
    rendered_cover_url = ""
    custom_cover_url = ""
    cover_bg_color = "#1a1a2e"
    cover_title_text = ""
    cover_author_text = ""
    cover_display_mode = "artwork"
    try:
        cd = project.cover_design
        cover_editor_mode = getattr(cd, "editor_mode", "generated") or "generated"
        if cd.rendered_cover:
            rendered_cover_url = f"{cd.rendered_cover.url}?v={int(cd.updated_at.timestamp())}"
        if getattr(cd, "custom_cover", None):
            custom_cover_url = f"{cd.custom_cover.url}?v={int(cd.updated_at.timestamp())}"
        if cd.cover_image:
            cover_image_url = f"{cd.cover_image.url}?v={int(cd.updated_at.timestamp())}"
        cover_bg_color = cd.bg_color
        cover_title_text = cd.title_text
        cover_author_text = cd.author_text
        cover_display_mode = cd.display_mode
    except Exception:
        pass

    return _BookData(
        title=project.title,
        author=author,
        logline=project.logline or "",
        cover_editor_mode=cover_editor_mode,
        rendered_cover_url=rendered_cover_url,
        custom_cover_url=custom_cover_url,
        cover_image_url=cover_image_url,
        cover_bg_color=cover_bg_color,
        cover_title_text=cover_title_text,
        cover_author_text=cover_author_text,
        cover_display_mode=cover_display_mode,
        front_matter=[{"title": s.title, "content": s.content or ""} for s in front],
        chapters=[
            {"title": ch.title, "content": ch.content or "", "position": idx}
            for idx, ch in enumerate(project.chapters.all(), start=1)
        ],
        back_matter=[{"title": s.title, "content": s.content or ""} for s in back],
    )


def _preferred_cover_asset_url(data: _BookData) -> str:
    if data.cover_editor_mode == "upload":
        return data.custom_cover_url or ""
    # Prefer flattened render (text + image). Fall back to background photo if render missing.
    return data.rendered_cover_url or data.cover_image_url or data.custom_cover_url or ""


def _media_relative_path_from_url(url: str) -> str:
    if not url:
        return ""
    path = url.split("?", 1)[0].strip()
    if path.startswith(("http://", "https://")):
        path = urlparse(path).path or ""
    for prefix in ("/media/", "media/"):
        if path.startswith(prefix):
            return path[len(prefix) :].lstrip("/")
    return path.lstrip("/")


def _cover_fs_candidates(data: _BookData) -> list[str]:
    if data.cover_editor_mode == "upload":
        return [u for u in [data.custom_cover_url] if u]
    seen: set[str] = set()
    out: list[str] = []
    for u in (data.rendered_cover_url, data.cover_image_url, data.custom_cover_url):
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _resolve_media_urls(html_content: str, base_url: str) -> str:
    """Replace relative /media/ URLs with absolute paths for WeasyPrint."""
    return re.sub(
        r'(src|href)="(/media/[^"]+)"',
        lambda m: f'{m.group(1)}="{base_url}{m.group(2)}"',
        html_content,
    )


def _build_html_document(data: _BookData, base_url: str = "", preview: bool = False) -> str:
    """Return a complete, self-contained HTML book document."""
    parts: list[str] = []

    parts.append("<!DOCTYPE html>")
    parts.append('<html lang="fr">')
    parts.append("<head>")
    parts.append('<meta charset="UTF-8">')
    parts.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    parts.append(f"<title>{data.title}</title>")
    styles = BOOK_CSS + (SCREEN_PREVIEW_CSS if preview else "")
    parts.append(f"<style>{styles}</style>")
    parts.append("</head>")
    parts.append("<body>")

    # Cover page – always show when cover data is available
    cover_img_url = _preferred_cover_asset_url(data)
    cover_img_url = _resolve_media_urls(cover_img_url, base_url) if (base_url and cover_img_url) else cover_img_url
    show_cover = bool(cover_img_url) or bool(data.cover_title_text) or bool(data.cover_author_text) or bool(data.cover_bg_color)
    if show_cover:
        bg = data.cover_bg_color or "#1a1a2e"
        if cover_img_url:
            parts.append(f'<div class="cover-page" style="background-color: {bg};">')
            parts.append(f'<img src="{cover_img_url}" alt="Couverture" class="cover-bg-img" />')
            parts.append("</div>")
        else:
            # Colored/default cover page with text only
            parts.append(f'<div class="cover-page" style="background-color: {bg};">')
            parts.append('<div class="cover-overlay">')
            if data.cover_title_text:
                parts.append(f'<div class="cover-title-text">{data.cover_title_text}</div>')
            if data.cover_author_text:
                parts.append(f'<div class="cover-author-text">{data.cover_author_text}</div>')
            parts.append("</div>")
            parts.append("</div>")

    # Title page
    parts.append('<div class="title-page">')
    parts.append(f"<h1>{data.title}</h1>")
    parts.append(f'<p class="author">{data.author}</p>')
    if data.logline:
        parts.append(f'<p class="logline">{data.logline}</p>')
    parts.append('<span class="ornament">&bull; &bull; &bull;</span>')
    parts.append("</div>")

    # Front matter
    for section in data.front_matter:
        parts.append('<div class="front-matter">')
        parts.append(f"<h2>{section['title']}</h2>")
        parts.append(f'<div class="section-body">{section["content"]}</div>')
        parts.append("</div>")

    # Chapters
    for chapter in data.chapters:
        chapter_content = _resolve_media_urls(chapter["content"], base_url) if base_url else chapter["content"]
        parts.append('<div class="chapter">')
        parts.append('<div class="chapter-header">')
        parts.append(f'<span class="chapter-number">Chapitre {chapter["position"]}</span>')
        parts.append(f"<h2>{chapter['title']}</h2>")
        # &mdash;&thinsp;&mdash;&thinsp;&mdash; → em-dash thin-space em-dash thin-space em-dash ornament
        parts.append('<span class="chapter-ornament">&mdash;&thinsp;&mdash;&thinsp;&mdash;</span>')
        parts.append("</div>")
        parts.append(f'<div class="chapter-body">{chapter_content}</div>')
        parts.append("</div>")

    # Back matter
    for section in data.back_matter:
        parts.append('<div class="back-matter">')
        parts.append(f"<h2>{section['title']}</h2>")
        parts.append(f'<div class="section-body">{section["content"]}</div>')
        parts.append("</div>")

    parts.append("</body>")
    parts.append("</html>")
    return "\n".join(parts)


# ---- Public API ----------------------------------------------------------


def export_html(project: Project, preview: bool = False) -> str:
    """Return a full self-contained HTML book document."""
    return _build_html_document(_gather_book_data(project), preview=preview)


def export_epub(project: Project) -> bytes:
    """Build an EPUB file and return its binary content."""
    from ebooklib import epub

    data = _gather_book_data(project)

    book = epub.EpubBook()
    book.set_identifier(f"inkrise-{project.slug}")
    book.set_title(data.title)
    book.set_language("fr")
    book.add_author(data.author)

    chapter_css = epub.EpubItem(
        uid="book_style",
        file_name="style/book.css",
        media_type="text/css",
        content=_epub_css().encode("utf-8"),
    )
    book.add_item(chapter_css)

    spine: list = ["nav"]
    toc: list = []
    cover_file_name = ""

    # Cover page (EPUB) – image or styled text cover
    cover_source_url = ""
    try:
        from django.conf import settings as django_settings

        media_root = str(getattr(django_settings, "MEDIA_ROOT", ""))
        for candidate in _cover_fs_candidates(data):
            rel_path = _media_relative_path_from_url(candidate)
            if not rel_path:
                continue
            fs_path = os.path.join(media_root, rel_path)
            if os.path.exists(fs_path):
                ext = fs_path.rsplit(".", 1)[-1].lower()
                mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")
                with open(fs_path, "rb") as f:
                    img_bytes = f.read()
                cover_file_name = f"cover.{ext}"
                cover_img_item = epub.EpubCover(file_name=cover_file_name, uid="cover-img")
                cover_img_item.content = img_bytes
                cover_img_item.media_type = mime
                book.add_item(cover_img_item)
                book.set_cover(cover_file_name, img_bytes)
                cover_source_url = candidate
                break
    except Exception:
        pass

    # Always add a styled cover HTML page when cover data exists
    if cover_source_url:
        cover_page_item = epub.EpubHtml(title="Couverture", file_name="cover_page.xhtml", lang="fr")
        cover_page_item.content = (
            '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">'
            f'<img src="{cover_file_name or "cover.png"}" alt="Couverture" style="width:100%;height:auto;" />'
            "</div>"
        )
        book.add_item(cover_page_item)
        spine.append(cover_page_item)
    elif data.cover_title_text or data.cover_author_text or data.cover_bg_color:
        bg = data.cover_bg_color or "#1a1a2e"
        cover_html = (
            f'<div style="background-color:{bg}; min-height:100vh; display:flex; flex-direction:column;'
            f' align-items:center; justify-content:center; padding:3em;">'
        )
        if data.cover_title_text:
            cover_html += f'<h1 style="color:#fff; text-align:center; margin:0 0 0.4em;">{data.cover_title_text}</h1>'
        if data.cover_author_text:
            cover_html += f'<p style="color:rgba(255,255,255,0.7); text-align:center; margin:0; font-size:1.1em;">{data.cover_author_text}</p>'
        cover_html += "</div>"
        cover_page_item = epub.EpubHtml(title="Couverture", file_name="cover_page.xhtml", lang="fr")
        cover_page_item.content = cover_html
        book.add_item(cover_page_item)
        spine.append(cover_page_item)

    # Title page
    title_html = (
        '<div class="title-page">'
        f"<h1>{data.title}</h1>"
        f'<p class="author">{data.author}</p>'
    )
    if data.logline:
        title_html += f'<p class="logline">{data.logline}</p>'
    title_html += "</div>"
    title_item = epub.EpubHtml(title="Page de titre", file_name="title.xhtml", lang="fr")
    title_item.content = title_html
    title_item.add_item(chapter_css)
    book.add_item(title_item)
    spine.append(title_item)

    # Front matter
    for idx, section in enumerate(data.front_matter):
        item = epub.EpubHtml(
            title=section["title"],
            file_name=f"front_{idx}.xhtml",
            lang="fr",
        )
        item.content = (
            f'<div class="front-matter">'
            f'<h2>{section["title"]}</h2>'
            f'<div class="section-body">{section["content"]}</div>'
            f"</div>"
        )
        item.add_item(chapter_css)
        book.add_item(item)
        spine.append(item)
        toc.append(epub.Link(item.file_name, section["title"], f"front_{idx}"))

    # Chapters
    for chapter in data.chapters:
        item = epub.EpubHtml(
            title=chapter["title"],
            file_name=f"chapter_{chapter['position']}.xhtml",
            lang="fr",
        )
        item.content = (
            f'<div class="chapter">'
            f'<div class="chapter-header">'
            f'<span class="chapter-number">Chapitre {chapter["position"]}</span>'
            f'<h2>{chapter["title"]}</h2>'
            f"</div>"
            f'<div class="chapter-body">{chapter["content"]}</div>'
            f"</div>"
        )
        item.add_item(chapter_css)
        book.add_item(item)
        spine.append(item)
        toc.append(epub.Link(item.file_name, chapter["title"], f"ch_{chapter['position']}"))

    # Back matter
    for idx, section in enumerate(data.back_matter):
        item = epub.EpubHtml(
            title=section["title"],
            file_name=f"back_{idx}.xhtml",
            lang="fr",
        )
        item.content = (
            f'<div class="back-matter">'
            f'<h2>{section["title"]}</h2>'
            f'<div class="section-body">{section["content"]}</div>'
            f"</div>"
        )
        item.add_item(chapter_css)
        book.add_item(item)
        spine.append(item)
        toc.append(epub.Link(item.file_name, section["title"], f"back_{idx}"))

    book.toc = toc
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = spine

    buf = io.BytesIO()
    epub.write_epub(buf, book, {})
    return buf.getvalue()


def export_pdf(project: Project, base_url: str = "") -> bytes:
    """Render the book-style HTML to a PDF via WeasyPrint."""
    try:
        from weasyprint import HTML
    except ImportError as exc:
        raise RuntimeError(
            "WeasyPrint is required for PDF export. Install it with: pip install weasyprint"
        ) from exc

    data = _gather_book_data(project)
    html_content = _build_html_document(data, base_url=base_url)

    # Provide a base_url so WeasyPrint can resolve relative media paths
    wp_base = base_url or settings.BASE_DIR.as_uri()
    return HTML(string=html_content, base_url=wp_base).write_pdf()


def export_text(project: Project) -> str:
    """Return a plain-text version of the manuscript."""
    data = _gather_book_data(project)

    parts = [data.title, "=" * len(data.title), ""]
    if data.logline:
        parts.extend([data.logline, ""])
    for section in data.front_matter:
        parts.extend([section["title"], "-" * len(section["title"]), strip_tags(section["content"]), ""])
    for chapter in data.chapters:
        parts.extend([chapter["title"], "-" * len(chapter["title"]), strip_tags(chapter["content"]), ""])
    for section in data.back_matter:
        parts.extend([section["title"], "-" * len(section["title"]), strip_tags(section["content"]), ""])
    return "\n".join(parts)


# ---- Internal helpers ----------------------------------------------------


def _epub_css() -> str:
    """Simplified CSS suitable for e-reader rendering."""
    return """\
body {
    font-family: serif;
    line-height: 1.7;
    color: #1a1a1a;
    margin: 1em;
}
.title-page {
    text-align: center;
    padding: 3em 0;
}
.title-page h1 {
    font-size: 2em;
    margin-bottom: 0.4em;
}
.title-page .author {
    font-size: 1.1em;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.06em;
}
.title-page .logline {
    font-style: italic;
    color: #666;
    margin-top: 1.5em;
}
.front-matter h2, .back-matter h2 {
    text-align: center;
    font-size: 1.4em;
    margin: 2em 0 1em;
}
.section-body { text-indent: 1.5em; }
.section-body p:first-child { text-indent: 0; }
.chapter-header {
    text-align: center;
    margin: 2em 0;
}
.chapter-number {
    display: block;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #999;
    margin-bottom: 0.3em;
}
.chapter-header h2 {
    font-size: 1.6em;
    margin: 0;
}
.chapter-body { text-indent: 1.5em; }
.chapter-body p:first-child { text-indent: 0; }
.chapter-body p { margin: 0 0 0.2em; }
.chapter-body img { max-width: 100%; height: auto; }
"""
