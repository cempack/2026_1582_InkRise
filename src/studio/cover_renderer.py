"""Render persisted cover compositions into exportable image assets."""

from __future__ import annotations

import io
import os
from copy import deepcopy
from urllib.parse import urlparse

from PIL import Image, ImageColor, ImageDraw, ImageFont, ImageFile, ImageOps

ImageFile.LOAD_TRUNCATED_IMAGES = True

CANVAS_WIDTH = 1600
CANVAS_HEIGHT = 2560
DEFAULT_TEXT_COLOR = "#f7f1e8"
DEFAULT_BG_COLOR = "#1a1a2e"

FONT_CANDIDATES = {
    "serif": [
        "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",
    ],
    "serif_bold": [
        "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf",
    ],
    "sans": [
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ],
    "sans_bold": [
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ],
}


def _first_existing(paths: list[str]) -> str | None:
    for path in paths:
        if os.path.exists(path):
            return path
    return None


def _pick_font_key(family: str, weight: str) -> str:
    family_lower = (family or "").lower()
    is_serif = any(token in family_lower for token in ["playfair", "lora", "serif", "georgia", "garamond"])
    base = "serif" if is_serif else "sans"
    if weight in {"600", "700", "800", "900", "bold"}:
        return f"{base}_bold"
    return base


def _load_font(family: str, size: int, weight: str = "400") -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font_key = _pick_font_key(family, weight)
    font_path = _first_existing(FONT_CANDIDATES[font_key])
    if font_path:
        try:
            return ImageFont.truetype(font_path, size=size)
        except OSError:
            pass
    # Keep export rendering readable even when runtime font files are missing
    # (for example inside slim Docker images).
    return ImageFont.load_default(size=size)


def _to_rgba(color: str | None, alpha: float = 1) -> tuple[int, int, int, int]:
    base = ImageColor.getrgb(color or DEFAULT_TEXT_COLOR)
    return (base[0], base[1], base[2], max(0, min(255, int(alpha * 255))))


def _box(layer: dict) -> tuple[int, int, int, int]:
    x = float(layer.get("x", 0))
    y = float(layer.get("y", 0))
    w = float(layer.get("w", 100))
    h = float(layer.get("h", 100))
    left = int((x / 100) * CANVAS_WIDTH)
    top = int((y / 100) * CANVAS_HEIGHT)
    width = int((w / 100) * CANVAS_WIDTH)
    height = int((h / 100) * CANVAS_HEIGHT)
    return left, top, max(1, width), max(1, height)


def _fit_image(
    image: Image.Image,
    box: tuple[int, int, int, int],
    fit: str,
    scale: float = 1.0,
    focus_x: float = 50.0,
    focus_y: float = 50.0,
) -> Image.Image:
    _, _, width, height = box
    if fit == "contain":
        image.thumbnail((width, height))
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        paste_x = (width - image.width) // 2
        paste_y = (height - image.height) // 2
        canvas.paste(image, (paste_x, paste_y), image)
        return canvas
    ratio = max(width / max(1, image.width), height / max(1, image.height)) * max(1.0, scale)
    resized = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))))
    free_x = max(0, resized.width - width)
    free_y = max(0, resized.height - height)
    left = int(free_x * max(0.0, min(100.0, focus_x)) / 100.0)
    top = int(free_y * max(0.0, min(100.0, focus_y)) / 100.0)
    return resized.crop((left, top, left + width, top + height))


def _render_cropped_background(
    image: Image.Image,
    box: tuple[int, int, int, int],
    crop_x: float,
    crop_y: float,
    crop_width: float,
    crop_height: float,
    rotation: float = 0.0,
    flip_x: int = 1,
    flip_y: int = 1,
) -> Image.Image:
    _, _, width, height = box
    working = image.convert("RGBA")
    if flip_x == -1:
        working = ImageOps.mirror(working)
    if flip_y == -1:
        working = ImageOps.flip(working)
    if rotation:
        working = working.rotate(-rotation, resample=Image.Resampling.BICUBIC, expand=True)

    natural_width, natural_height = working.size
    left = int(max(0.0, min(100.0, crop_x)) / 100.0 * natural_width)
    top = int(max(0.0, min(100.0, crop_y)) / 100.0 * natural_height)
    crop_w = int(max(1.0, min(100.0, crop_width)) / 100.0 * natural_width)
    crop_h = int(max(1.0, min(100.0, crop_height)) / 100.0 * natural_height)
    right = min(natural_width, left + max(1, crop_w))
    bottom = min(natural_height, top + max(1, crop_h))
    cropped = working.crop((left, top, right, bottom))
    return cropped.resize((width, height), Image.Resampling.LANCZOS)


def _strip_url_to_rel_path(src: str) -> str:
    """Turn /media/foo.png?v=1 or full URLs into a safe relative media path."""
    if not src:
        return ""
    s = src.strip()
    if s.startswith(("http://", "https://")):
        parsed = urlparse(s)
        s = parsed.path or ""
    rel = s
    for prefix in ("/media/", "media/"):
        if rel.startswith(prefix):
            rel = rel[len(prefix):]
            break
    rel = rel.split("?", 1)[0].split("#", 1)[0].strip("/")
    if ".." in rel.split("/"):
        return ""
    return rel


def _resolve_media_path(src: str, media_root: str) -> str | None:
    rel_path = _strip_url_to_rel_path(src)
    if not rel_path:
        return None
    path = os.path.join(media_root, rel_path)
    if os.path.exists(path):
        return path
    return None


def default_cover_composition(cover) -> dict:
    bg_image = cover.cover_image.url if getattr(cover, "cover_image", None) else ""
    title_text = cover.title_text or cover.project.title
    author_text = cover.author_text or (
        cover.project.user.profile.pen_name
        or cover.project.user.get_full_name()
        or cover.project.user.username
    )
    subtitle_text = cover.subtitle_text or ""
    return {
        "version": 2,
        "layers": [
            {
                "id": "bg",
                "type": "background",
                "x": 0,
                "y": 0,
                "w": 100,
                "h": 100,
                "color": cover.bg_color or DEFAULT_BG_COLOR,
                "imageUrl": bg_image,
                "fit": "cover",
                "opacity": 1,
                "locked": True,
                "visible": True,
                "zIndex": 0,
            },
            {
                "id": "subtitle",
                "type": "text",
                "role": "subtitle",
                "text": subtitle_text,
                "x": 12,
                "y": 12,
                "w": 76,
                "h": 8,
                "fontFamily": cover.subtitle_font,
                "fontSize": cover.subtitle_size,
                "fontWeight": "500",
                "color": cover.subtitle_color or cover.title_color or DEFAULT_TEXT_COLOR,
                "align": "center",
                "opacity": 1,
                "visible": bool(subtitle_text),
                "zIndex": 10,
            },
            {
                "id": "title",
                "type": "text",
                "role": "title",
                "text": title_text,
                "x": 10,
                "y": 28,
                "w": 80,
                "h": 24,
                "fontFamily": cover.title_font,
                "fontSize": cover.title_size,
                "fontWeight": "700",
                "color": cover.title_color or DEFAULT_TEXT_COLOR,
                "align": "center",
                "opacity": 1,
                "visible": True,
                "zIndex": 20,
            },
            {
                "id": "author",
                "type": "text",
                "role": "author",
                "text": author_text,
                "x": 16,
                "y": 84,
                "w": 68,
                "h": 8,
                "fontFamily": cover.author_font,
                "fontSize": cover.author_size,
                "fontWeight": "600",
                "color": cover.author_color or DEFAULT_TEXT_COLOR,
                "align": "center",
                "opacity": 1,
                "visible": True,
                "zIndex": 30,
            },
        ],
    }


def normalize_cover_composition(raw: dict | None, cover) -> dict:
    composition = deepcopy(raw) if isinstance(raw, dict) else {}
    if not composition.get("layers"):
        composition = default_cover_composition(cover)

    normalized_layers = []
    for index, layer in enumerate(composition.get("layers", [])):
        if not isinstance(layer, dict):
            continue
        layer_type = str(layer.get("type") or "text")
        normalized = {
            "id": str(layer.get("id") or f"layer-{index}")[:80],
            "type": layer_type,
            "x": max(0.0, min(100.0, float(layer.get("x", 0)))),
            "y": max(0.0, min(100.0, float(layer.get("y", 0)))),
            "w": max(1.0, min(100.0, float(layer.get("w", 100)))),
            "h": max(1.0, min(100.0, float(layer.get("h", 100)))),
            "opacity": max(0.0, min(1.0, float(layer.get("opacity", 1)))),
            "visible": bool(layer.get("visible", True)),
            "zIndex": int(layer.get("zIndex", index * 10)),
        }
        if layer_type == "background":
            normalized["color"] = str(layer.get("color") or DEFAULT_BG_COLOR)[:20]
            normalized["imageUrl"] = str(layer.get("imageUrl") or "")[:500]
            normalized["fit"] = "cover"
            normalized["scale"] = max(1.0, min(3.0, float(layer.get("scale", 1))))
            normalized["focusX"] = max(0.0, min(100.0, float(layer.get("focusX", 50))))
            normalized["focusY"] = max(0.0, min(100.0, float(layer.get("focusY", 50))))
            normalized["cropX"] = max(0.0, min(99.0, float(layer.get("cropX", 0))))
            normalized["cropY"] = max(0.0, min(99.0, float(layer.get("cropY", 0))))
            normalized["cropWidth"] = max(1.0, min(100.0, float(layer.get("cropWidth", 100))))
            normalized["cropHeight"] = max(1.0, min(100.0, float(layer.get("cropHeight", 100))))
            normalized["rotation"] = max(-180.0, min(180.0, float(layer.get("rotation", 0))))
            normalized["flipX"] = -1 if int(layer.get("flipX", 1)) == -1 else 1
            normalized["flipY"] = -1 if int(layer.get("flipY", 1)) == -1 else 1
            normalized["overlayColor"] = str(layer.get("overlayColor") or "#09090b")[:20]
            normalized["overlayOpacity"] = max(0.0, min(0.9, float(layer.get("overlayOpacity", 0.22))))
            normalized["locked"] = True
            normalized["x"] = 0
            normalized["y"] = 0
            normalized["w"] = 100
            normalized["h"] = 100
        elif layer_type == "image":
            normalized["imageUrl"] = str(layer.get("imageUrl") or "")[:500]
            normalized["fit"] = str(layer.get("fit") or "cover") if str(layer.get("fit") or "cover") in {"cover", "contain"} else "cover"
            normalized["radius"] = max(0, min(80, int(layer.get("radius", 0))))
        elif layer_type == "ornament":
            normalized["glyph"] = str(layer.get("glyph") or "✦")[:40]
            normalized["color"] = str(layer.get("color") or DEFAULT_TEXT_COLOR)[:20]
            normalized["fontSize"] = max(12, min(220, int(layer.get("fontSize", 48))))
        else:
            normalized["type"] = "text"
            normalized["role"] = str(layer.get("role") or "custom")[:30]
            normalized["text"] = str(layer.get("text") or "")[:400]
            normalized["fontFamily"] = str(layer.get("fontFamily") or "Georgia, serif")[:120]
            normalized["fontSize"] = max(12, min(220, int(layer.get("fontSize", 48))))
            normalized["fontWeight"] = str(layer.get("fontWeight") or "400")[:10]
            normalized["color"] = str(layer.get("color") or DEFAULT_TEXT_COLOR)[:20]
            normalized["align"] = str(layer.get("align") or "left") if str(layer.get("align") or "left") in {"left", "center", "right"} else "left"
            normalized["uppercase"] = bool(layer.get("uppercase", False))
        normalized_layers.append(normalized)

    normalized_layers.sort(key=lambda layer: (layer.get("zIndex", 0), layer["id"]))
    return {"version": 2, "layers": normalized_layers}


def render_cover_image(composition: dict, media_root: str) -> bytes:
    image = Image.new("RGBA", (CANVAS_WIDTH, CANVAS_HEIGHT), _to_rgba(DEFAULT_BG_COLOR))

    for layer in sorted(composition.get("layers", []), key=lambda item: (item.get("zIndex", 0), item["id"])):
        if not layer.get("visible", True):
            continue
        if layer["type"] == "background":
            base = Image.new("RGBA", image.size, _to_rgba(layer.get("color"), layer.get("opacity", 1)))
            bg_path = _resolve_media_path(layer.get("imageUrl", ""), media_root)
            if bg_path:
                with Image.open(bg_path) as bg_source:
                    if (
                        float(layer.get("cropX", 0)) != 0
                        or float(layer.get("cropY", 0)) != 0
                        or float(layer.get("cropWidth", 100)) != 100
                        or float(layer.get("cropHeight", 100)) != 100
                        or float(layer.get("rotation", 0)) != 0
                        or int(layer.get("flipX", 1)) != 1
                        or int(layer.get("flipY", 1)) != 1
                    ):
                        bg_image = _render_cropped_background(
                            bg_source,
                            (0, 0, CANVAS_WIDTH, CANVAS_HEIGHT),
                            float(layer.get("cropX", 0)),
                            float(layer.get("cropY", 0)),
                            float(layer.get("cropWidth", 100)),
                            float(layer.get("cropHeight", 100)),
                            float(layer.get("rotation", 0)),
                            int(layer.get("flipX", 1)),
                            int(layer.get("flipY", 1)),
                        )
                    else:
                        bg_image = _fit_image(
                            bg_source.convert("RGBA"),
                            (0, 0, CANVAS_WIDTH, CANVAS_HEIGHT),
                            "cover",
                            float(layer.get("scale", 1)),
                            float(layer.get("focusX", 50)),
                            float(layer.get("focusY", 50)),
                        )
                    if layer.get("opacity", 1) < 1:
                        alpha = bg_image.getchannel("A").point(lambda value: int(value * layer.get("opacity", 1)))
                        bg_image.putalpha(alpha)
                    base.alpha_composite(bg_image, (0, 0))
            overlay_opacity = float(layer.get("overlayOpacity", 0))
            if overlay_opacity > 0:
                overlay = Image.new("RGBA", image.size, _to_rgba(layer.get("overlayColor"), overlay_opacity))
                base.alpha_composite(overlay, (0, 0))
            image.alpha_composite(base)
            continue

        left, top, width, height = _box(layer)
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))

        if layer["type"] == "image" and layer.get("imageUrl"):
            img_path = _resolve_media_path(layer.get("imageUrl"), media_root)
            if img_path:
                with Image.open(img_path) as source:
                    rendered = _fit_image(source.convert("RGBA"), (left, top, width, height), layer.get("fit", "cover"))
                    if layer.get("opacity", 1) < 1:
                        alpha = rendered.getchannel("A").point(lambda value: int(value * layer.get("opacity", 1)))
                        rendered.putalpha(alpha)
                    overlay.alpha_composite(rendered, (0, 0))
        elif layer["type"] == "ornament":
            draw = ImageDraw.Draw(overlay)
            # Sans fonts (DejaVu/Liberation) render decorative Unicode more reliably than tiny PIL default.
            font = _load_font("sans", int(layer.get("fontSize", 48)), "700")
            glyph = str(layer.get("glyph", "✦") or "✦")
            bbox_try = draw.textbbox((0, 0), glyph, font=font)
            if bbox_try[2] - bbox_try[0] <= 1 and bbox_try[3] - bbox_try[1] <= 1:
                glyph = "+"
                font = _load_font("sans", int(layer.get("fontSize", 48)), "700")
            bbox = draw.textbbox((0, 0), glyph, font=font)
            glyph_width = bbox[2] - bbox[0]
            glyph_height = bbox[3] - bbox[1]
            x = max(0, (width - glyph_width) // 2)
            y = max(0, (height - glyph_height) // 2)
            draw.text((x, y), glyph, font=font, fill=_to_rgba(layer.get("color"), layer.get("opacity", 1)))
        elif layer["type"] == "text":
            draw = ImageDraw.Draw(overlay)
            font = _load_font(layer.get("fontFamily", ""), int(layer.get("fontSize", 48)), layer.get("fontWeight", "400"))
            text = layer.get("text", "")
            if layer.get("uppercase"):
                text = text.upper()
            lines = [line for line in text.splitlines() if line] or [text]
            font_size = int(layer.get("fontSize", 48))
            line_height = int(font_size * 1.18)
            total_height = line_height * len(lines)
            current_y = max(0, (height - total_height) // 2)
            for line in lines:
                bbox = draw.textbbox((0, 0), line, font=font)
                line_width = bbox[2] - bbox[0]
                if layer.get("align") == "center":
                    current_x = max(0, (width - line_width) // 2)
                elif layer.get("align") == "right":
                    current_x = max(0, width - line_width)
                else:
                    current_x = 0
                draw.text((current_x, current_y), line, font=font, fill=_to_rgba(layer.get("color"), layer.get("opacity", 1)))
                current_y += line_height

        image.alpha_composite(overlay, (left, top))

    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()
