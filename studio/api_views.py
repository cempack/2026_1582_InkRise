import base64
import json
import re
import uuid
from datetime import timedelta
from functools import wraps

from django.contrib.auth import authenticate, login, logout
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.http import Http404, HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import api_i18n
from .forms import (
    ChapterNoteForm,
    CharacterClassForm,
    CharacterForm,
    DictionaryEntryForm,
    FrontBackMatterForm,
    PlaceForm,
    ProfileForm,
    ProjectForm,
    ProjectFormattingForm,
    RegisterForm,
    ResearchNoteForm,
    WritingGoalForm,
)
from .models import (
    Chapter, ChapterNote, ChapterRevision, ChapterSummary,
    Character, CharacterClass, Connection, CoverDesign, FrontBackMatter,
    MapNode, Place, Project, ProjectDictionaryEntry, ResearchNote, WritingGoal,
)
from .serializers import (
    serialize_character,
    serialize_character_class,
    serialize_connection,
    serialize_dictionary_entry,
    serialize_front_back_matter,
    serialize_map_node,
    serialize_media_url,
    serialize_place,
    serialize_profile,
    serialize_project_detail,
    serialize_project_summary,
    serialize_research_note,
    serialize_user,
    serialize_workspace,
    serialize_writing_goal,
)
from .cover_renderer import default_cover_composition, normalize_cover_composition, render_cover_image
from .export_service import export_epub, export_html, export_pdf, export_text
from .services import ShortTextCorrector, ThesaurusService


def api_login_required(view_func):
    @wraps(view_func)
    def wrapped(request: HttpRequest, *args, **kwargs):
        if not request.user.is_authenticated:
            return JsonResponse({"error": api_i18n.AUTH_REQUIRED}, status=401)
        return view_func(request, *args, **kwargs)

    return wrapped


def json_body(request: HttpRequest) -> dict:
    if not request.body:
        return {}
    try:
        return json.loads(request.body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid JSON payload.") from exc


def form_errors(form) -> dict:
    return {field: [str(error) for error in errors] for field, errors in form.errors.items()}


def get_project(user, slug: str) -> Project:
    return get_object_or_404(
        Project.objects.select_related("cover_design", "writing_goal").prefetch_related(
            "chapters",
            "dictionary_entries",
            "character_classes",
            "characters",
            "places",
        ),
        user=user,
        slug=slug,
    )


def get_chapter(project: Project, chapter_id: int) -> Chapter:
    return get_object_or_404(
        Chapter.objects.prefetch_related("notes", "revisions").select_related("summary"),
        project=project,
        pk=chapter_id,
    )


def ensure_summary(chapter: Chapter) -> ChapterSummary:
    summary, _ = ChapterSummary.objects.get_or_create(chapter=chapter)
    return summary


def _coerce_float(value, field_name: str) -> float:
    """Convert a request value to float and raise a consistent API validation error."""
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid {field_name}: must be a numeric value.") from exc


def _sanitize_cover_layers(value) -> list[dict]:
    """Validate and normalize cover layer descriptors before persisting JSON data."""
    if not isinstance(value, list):
        raise ValueError(f"Layers must be a list, received {type(value).__name__}.")
    sanitized_layers: list[dict] = []
    for layer in value:
        if not isinstance(layer, dict):
            raise ValueError("Each layer must be a dictionary.")
        layer_id = str(layer.get("id", "")).strip()
        layer_type = str(layer.get("type", "")).strip()
        if not layer_id or layer_type not in {"background", "text", "element", "image", "ornament"}:
            raise ValueError("Invalid layer descriptor: must include id and type (background, text, image, ornament, or element).")
        sanitized = {
            "id": layer_id[:80],
            "type": layer_type,
            "label": str(layer.get("label", "")).strip()[:120],
            "visible": bool(layer.get("visible", True)),
        }
        if layer_type == "element":
            element_id = str(layer.get("elementId", "")).strip()
            if not element_id:
                raise ValueError("Element layers must include a non-empty elementId.")
            sanitized["elementId"] = element_id[:60]
            if "posX" in layer:
                sanitized["posX"] = max(0, min(100, int(layer.get("posX"))))
            if "posY" in layer:
                sanitized["posY"] = max(0, min(100, int(layer.get("posY"))))
            if "size" in layer:
                sanitized["size"] = max(8, min(200, int(layer.get("size"))))
        elif layer_type in {"image", "ornament", "background", "text"}:
            sanitized["data"] = layer
        sanitized_layers.append(sanitized)
    return sanitized_layers


VALID_NODE_KINDS = {choice[0] for choice in MapNode.KIND_CHOICES}
NODE_KIND_FROM_SOURCE = {
    "characters": "character",
    "places": "place",
    "chapters": "chapter",
}


def _normalize_node_kind(value: str | None, source_type: str = "") -> str:
    if value in VALID_NODE_KINDS:
        return str(value)
    return NODE_KIND_FROM_SOURCE.get(source_type, "custom")


def _normalize_hex_color(value: str | None, default: str = "#c49a6c") -> str:
    color = str(value or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        return color.lower()
    return default


def _cover_author_name(project: Project) -> str:
    return (
        project.user.profile.pen_name
        or project.user.get_full_name()
        or project.user.username
    )


def _normalize_cover_editor_mode(value: str | None) -> str:
    return value if value in {"generated", "upload"} else "generated"


def _infer_cover_template_id(cover: CoverDesign) -> str:
    if cover.template_id:
        return cover.template_id
    bg_color = (cover.bg_color or "").lower()
    title_font = (cover.title_font or "").lower()
    if bg_color == "#f3ece1":
        return "paper-bloom"
    if bg_color == "#2d1716":
        return "ember-line"
    if bg_color == "#10202b":
        return "fjord-ink"
    if "libre baskerville" in title_font:
        return "fjord-ink"
    return "editorial-night"


def _delete_file_if_present(file_field) -> bool:
    if not file_field:
        return False
    try:
        default_storage.delete(file_field.name)
    except Exception:
        pass
    return True


def _clear_rendered_cover(cover: CoverDesign) -> bool:
    if not cover.rendered_cover:
        return False
    _delete_file_if_present(cover.rendered_cover)
    cover.rendered_cover = None
    return True


def _rendered_cover_missing_on_disk(cover: CoverDesign) -> bool:
    if not cover.rendered_cover:
        return True
    try:
        return not default_storage.exists(cover.rendered_cover.name)
    except Exception:
        return True


def _ensure_cover_render(cover: CoverDesign) -> list[str]:
    update_fields: list[str] = []
    if not cover.composition:
        cover.composition = default_cover_composition(cover)
        update_fields.append("composition")
    cover.editor_mode = _normalize_cover_editor_mode(cover.editor_mode)
    if cover.editor_mode == "upload":
        if _clear_rendered_cover(cover):
            update_fields.extend(["rendered_cover", "updated_at"])
        return list(dict.fromkeys(update_fields))
    if _rendered_cover_missing_on_disk(cover):
        if cover.rendered_cover:
            _clear_rendered_cover(cover)
        _save_cover_render(cover)
        update_fields.extend(["rendered_cover", "updated_at"])
    return list(dict.fromkeys(update_fields))


def _save_cover_render(cover: CoverDesign) -> None:
    if _normalize_cover_editor_mode(cover.editor_mode) == "upload":
        _clear_rendered_cover(cover)
        return
    composition = normalize_cover_composition(cover.composition or default_cover_composition(cover), cover)
    cover.composition = composition
    image_bytes = render_cover_image(composition, str(default_storage.location))
    filename = f"{cover.project.slug}-{uuid.uuid4().hex[:8]}.png"
    if cover.rendered_cover:
        try:
            default_storage.delete(cover.rendered_cover.name)
        except Exception:
            pass
    cover.rendered_cover.save(filename, ContentFile(image_bytes), save=False)


def _recent_revision_payload(project: Project, limit: int = 8) -> list[dict]:
    revisions = (
        ChapterRevision.objects.filter(chapter__project=project)
        .select_related("chapter")
        .order_by("-created_at")[:limit]
    )
    return [
        {
            "id": revision.pk,
            "chapterTitle": revision.chapter.title,
            "chapterId": revision.chapter_id,
            "source": revision.source,
            "wordCount": revision.word_count,
            "createdAt": revision.created_at.isoformat(),
        }
        for revision in revisions
    ]


def maybe_create_revision(chapter: Chapter, source: str = "autosave") -> None:
    latest = chapter.revisions.first()
    if latest and latest.title == chapter.title and latest.content == chapter.content:
        return
    if latest and source == "autosave":
        age = timezone.now() - latest.created_at
        changed_characters = abs(latest.character_count - chapter.character_count)
        if age < timedelta(minutes=2) and changed_characters < 120:
            return
    ChapterRevision.objects.create(
        chapter=chapter,
        title=chapter.title,
        content=chapter.content,
        word_count=chapter.word_count,
        character_count=chapter.character_count,
        source=source,
    )


@require_GET
def session_view(request: HttpRequest) -> JsonResponse:
    if not request.user.is_authenticated:
        return JsonResponse({"authenticated": False, "user": None})
    projects = (
        request.user.projects.select_related("cover_design")
        .prefetch_related("chapters")
        .all()
    )
    return JsonResponse(
        {
            "authenticated": True,
            "user": serialize_user(request.user),
            "projects": [serialize_project_summary(project) for project in projects],
        }
    )


@require_POST
def login_view(request: HttpRequest) -> JsonResponse:
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    username = payload.get("username", "").strip()
    password = payload.get("password", "")
    user = authenticate(request, username=username, password=password)
    if user is None:
        return JsonResponse({"error": api_i18n.INVALID_CREDENTIALS}, status=400)
    login(request, user)
    return JsonResponse({"authenticated": True, "user": serialize_user(user)})


@require_POST
def register_view(request: HttpRequest) -> JsonResponse:
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    form = RegisterForm(payload)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    user = form.save()
    login(request, user)
    return JsonResponse({"authenticated": True, "user": serialize_user(user)}, status=201)


@require_POST
def logout_view(request: HttpRequest) -> JsonResponse:
    logout(request)
    return JsonResponse({"authenticated": False})


@api_login_required
@require_http_methods(["GET", "POST"])
def profile_view(request: HttpRequest) -> JsonResponse:
    if request.method == "GET":
        return JsonResponse({"profile": serialize_profile(request.user.profile), "user": serialize_user(request.user)})

    payload = request.POST if request.content_type and request.content_type.startswith("multipart/form-data") else json_body(request)
    form = ProfileForm(payload, request.FILES or None, instance=request.user.profile)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    profile = form.save()
    return JsonResponse({"profile": serialize_profile(profile), "user": serialize_user(request.user)})


@api_login_required
@require_http_methods(["GET", "POST"])
def projects_view(request: HttpRequest) -> JsonResponse:
    if request.method == "GET":
        projects = request.user.projects.prefetch_related("chapters").all()
        return JsonResponse({"projects": [serialize_project_summary(project) for project in projects]})

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    form = ProjectForm(payload)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    project = form.save(commit=False)
    project.user = request.user
    project.apply_profile_defaults(request.user.profile)
    project.save()
    chapter = Chapter.objects.create(project=project, title="Chapter 1")
    ensure_summary(chapter)
    return JsonResponse(
        {
            "project": serialize_project_detail(project),
            "redirect": f"/projects/{project.slug}/workspace/{chapter.pk}/",
        },
        status=201,
    )


@api_login_required
@require_http_methods(["GET", "PUT"])
def project_detail_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        return JsonResponse({"project": serialize_project_detail(project)})

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    form = ProjectForm(payload, instance=project)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    project = form.save()
    return JsonResponse({"project": serialize_project_detail(project)})


@api_login_required
@require_GET
def workspace_view(request: HttpRequest, project_slug: str, chapter_id: int | None = None) -> JsonResponse:
    project = get_project(request.user, project_slug)
    current_chapter = get_chapter(project, chapter_id) if chapter_id else project.chapters.first()
    if current_chapter is None:
        current_chapter = Chapter.objects.create(project=project, title="Chapter 1")
    ensure_summary(current_chapter)
    return JsonResponse(serialize_workspace(project, current_chapter))


@api_login_required
@require_POST
def chapter_create_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    try:
        payload = json_body(request)
    except ValueError:
        payload = {}
    title = (payload.get("title") or "").strip() or f"Chapter {project.chapters.count() + 1}"
    chapter = Chapter.objects.create(project=project, title=title)
    ensure_summary(chapter)
    refreshed = get_project(request.user, project_slug)
    refreshed_chapter = get_chapter(refreshed, chapter.pk)
    return JsonResponse({"chapter": serialize_workspace(refreshed, refreshed_chapter)["currentChapter"], "chapters": serialize_project_detail(refreshed)["chapters"]})


@api_login_required
@require_POST
def chapter_move_view(request: HttpRequest, project_slug: str, chapter_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    chapter = get_chapter(project, chapter_id)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    direction = payload.get("direction")
    if direction not in {"up", "down"}:
        return JsonResponse({"error": api_i18n.DIRECTION_INVALID}, status=400)
    swap_with = (
        project.chapters.filter(position__lt=chapter.position).order_by("-position").first()
        if direction == "up"
        else project.chapters.filter(position__gt=chapter.position).order_by("position").first()
    )
    if swap_with:
        chapter.position, swap_with.position = swap_with.position, chapter.position
        Chapter.objects.filter(pk=chapter.pk).update(position=chapter.position)
        Chapter.objects.filter(pk=swap_with.pk).update(position=swap_with.position)
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"chapters": serialize_project_detail(refreshed)["chapters"]})


@api_login_required
@require_http_methods(["DELETE"])
def chapter_delete_view(request: HttpRequest, project_slug: str, chapter_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    chapter = get_chapter(project, chapter_id)
    chapter.delete()
    remaining = list(project.chapters.order_by("position"))
    next_chapter = remaining[0] if remaining else Chapter.objects.create(project=project, title="Chapter 1")
    ensure_summary(next_chapter)
    for index, item in enumerate(project.chapters.order_by("position"), start=1):
        if item.position != index:
            Chapter.objects.filter(pk=item.pk).update(position=index)
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"chapters": serialize_project_detail(refreshed)["chapters"], "nextChapterId": next_chapter.pk})


@api_login_required
@require_POST
def autosave_chapter_view(request: HttpRequest, project_slug: str, chapter_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    chapter = get_chapter(project, chapter_id)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    chapter.title = (payload.get("title") or chapter.title).strip() or chapter.title
    chapter.content = payload.get("content", "")
    chapter.touch_autosave()
    chapter.save()
    maybe_create_revision(chapter, source="autosave")
    refreshed = get_project(request.user, project_slug)
    return JsonResponse(
        {
            "status": "saved",
            "chapter": {
                "id": chapter.pk,
                "title": chapter.title,
                "wordCount": chapter.word_count,
                "characterCount": chapter.character_count,
                "savedAt": chapter.last_autosaved_at.isoformat() if chapter.last_autosaved_at else None,
            },
            "project": serialize_project_detail(refreshed),
        }
    )


@api_login_required
@require_POST
def upload_chapter_image_view(request: HttpRequest, project_slug: str, chapter_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    get_chapter(project, chapter_id)
    upload = request.FILES.get("image")
    if not upload:
        return JsonResponse({"error": api_i18n.NO_IMAGE}, status=400)
    filename = default_storage.save(f"chapter-images/{project.slug}/{uuid.uuid4().hex}-{upload.name}", upload)
    return JsonResponse({"url": default_storage.url(filename)})


@api_login_required
@require_POST
def save_summary_view(request: HttpRequest, project_slug: str, chapter_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    chapter = get_chapter(project, chapter_id)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    summary = ensure_summary(chapter)
    summary.summary = payload.get("summary", "")
    summary.save()
    return JsonResponse({"summary": summary.summary, "savedAt": summary.updated_at.isoformat()})


@api_login_required
@require_http_methods(["GET", "POST"])
def dictionary_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        return JsonResponse({"entries": [serialize_dictionary_entry(entry) for entry in project.dictionary_entries.all()]})

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    mapped_payload = {
        "term": payload.get("term"),
        "definition": payload.get("definition"),
        "usage_notes": payload.get("usageNotes", payload.get("usage_notes")),
    }
    instance = None
    if payload.get("id"):
        instance = get_object_or_404(ProjectDictionaryEntry, project=project, pk=payload["id"])
    form = DictionaryEntryForm(mapped_payload, instance=instance)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    entry = form.save(commit=False)
    entry.project = project
    entry.save()
    refreshed = get_project(request.user, project_slug)
    refreshed_entry = get_object_or_404(ProjectDictionaryEntry, project=refreshed, pk=entry.pk)
    return JsonResponse({"entry": serialize_dictionary_entry(refreshed_entry), "entries": [serialize_dictionary_entry(item) for item in refreshed.dictionary_entries.all()]})


@api_login_required
@require_http_methods(["DELETE"])
def dictionary_delete_view(request: HttpRequest, project_slug: str, entry_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    entry = get_object_or_404(ProjectDictionaryEntry, project=project, pk=entry_id)
    entry.delete()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"entries": [serialize_dictionary_entry(item) for item in refreshed.dictionary_entries.all()]})


@api_login_required
@require_http_methods(["POST"])
def notes_view(request: HttpRequest, project_slug: str, chapter_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    chapter = get_chapter(project, chapter_id)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    instance = None
    if payload.get("id"):
        instance = get_object_or_404(ChapterNote, chapter=chapter, pk=payload["id"])
    form = ChapterNoteForm(payload, instance=instance)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    note = form.save(commit=False)
    note.chapter = chapter
    note.save()
    refreshed_project = get_project(request.user, project_slug)
    refreshed_chapter = get_chapter(refreshed_project, chapter_id)
    return JsonResponse({"notes": serialize_workspace(refreshed_project, refreshed_chapter)["currentChapter"]["notes"]})


@api_login_required
@require_http_methods(["DELETE"])
def note_delete_view(request: HttpRequest, project_slug: str, chapter_id: int, note_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    chapter = get_chapter(project, chapter_id)
    note = get_object_or_404(ChapterNote, chapter=chapter, pk=note_id)
    note.delete()
    refreshed_project = get_project(request.user, project_slug)
    refreshed_chapter = get_chapter(refreshed_project, chapter_id)
    return JsonResponse({"notes": serialize_workspace(refreshed_project, refreshed_chapter)["currentChapter"]["notes"]})


@api_login_required
@require_POST
def save_formatting_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    mapped_payload = {
        "manuscript_font_family": payload.get("fontFamily"),
        "manuscript_font_size": payload.get("fontSize"),
        "manuscript_line_height": payload.get("lineHeight"),
        "manuscript_width": payload.get("manuscriptWidth"),
    }
    form = ProjectFormattingForm(mapped_payload, instance=project)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    project = form.save()
    return JsonResponse({"formatting": serialize_project_detail(project)["formatting"]})


@api_login_required
@require_GET
def thesaurus_lookup_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    get_project(request.user, project_slug)
    result = ThesaurusService().lookup(request.GET.get("term", ""))
    return JsonResponse(result)


@api_login_required
@require_POST
def correct_text_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    get_project(request.user, project_slug)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    text = payload.get("text", "")
    if len(text) > 500:
        return JsonResponse({"error": api_i18n.CORRECTION_TOO_LONG}, status=400)
    corrected = ShortTextCorrector().correct(text)
    return JsonResponse({"original": text, "corrected": corrected})


@api_login_required
@require_http_methods(["GET", "POST"])
def character_classes_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        return JsonResponse({"classes": [serialize_character_class(item) for item in project.character_classes.prefetch_related("characters").all()]})

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    instance = None
    if payload.get("id"):
        instance = get_object_or_404(CharacterClass, project=project, pk=payload["id"])
    form = CharacterClassForm(payload, instance=instance)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    character_class = form.save(commit=False)
    character_class.project = project
    character_class.save()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"classes": [serialize_character_class(item) for item in refreshed.character_classes.prefetch_related("characters").all()]})


@api_login_required
@require_http_methods(["DELETE"])
def character_class_delete_view(request: HttpRequest, project_slug: str, class_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    character_class = get_object_or_404(CharacterClass, project=project, pk=class_id)
    character_class.delete()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"classes": [serialize_character_class(item) for item in refreshed.character_classes.prefetch_related("characters").all()]})


@api_login_required
@require_http_methods(["GET", "POST"])
def characters_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        return JsonResponse(
            {
                "classes": [serialize_character_class(item) for item in project.character_classes.prefetch_related("characters").all()],
                "characters": [serialize_character(item) for item in project.characters.prefetch_related("classes").all()],
            }
        )

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    instance = None
    if payload.get("id"):
        instance = get_object_or_404(Character.objects.prefetch_related("classes"), project=project, pk=payload["id"])
    def _opt_int(key_snake, key_camel=None):
        raw = payload.get(key_snake)
        if raw is None and key_camel:
            raw = payload.get(key_camel)
        if raw is None or raw == "":
            return None
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    mapped_payload = {
        "name": payload.get("name"),
        "role": payload.get("role"),
        "first_name": payload.get("first_name") or payload.get("firstName"),
        "last_name": payload.get("last_name") or payload.get("lastName"),
        "nickname": payload.get("nickname"),
        "pronouns": payload.get("pronouns"),
        "sex_or_gender": payload.get("sex_or_gender") or payload.get("sexOrGender"),
        "species": payload.get("species"),
        "age": _opt_int("age"),
        "birth_date": payload.get("birth_date") or payload.get("birthDate") or None,
        "birth_place": payload.get("birth_place") or payload.get("birthPlace"),
        "residence": payload.get("residence"),
        "occupation": payload.get("occupation"),
        "summary": payload.get("summary"),
        "appearance": payload.get("appearance"),
        "personality": payload.get("personality"),
        "backstory": payload.get("backstory"),
        "evolution": payload.get("evolution"),
        "goals": payload.get("goals"),
        "conflicts": payload.get("conflicts"),
        "inventory": payload.get("inventory"),
        "possessions": payload.get("possessions"),
        "extras": payload.get("extras"),
        "notes": payload.get("notes"),
        "star_rating": _opt_int("star_rating", "starRating") or 3,
        "classes": payload.get("classIds", []),
    }
    if mapped_payload["star_rating"] is None:
        mapped_payload["star_rating"] = 3
    mapped_payload["star_rating"] = max(1, min(5, int(mapped_payload["star_rating"])))

    form = CharacterForm(mapped_payload, instance=instance, project=project)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    character = form.save(commit=False)
    character.project = project
    character.save()
    form.save_m2m()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse(
        {
            "classes": [serialize_character_class(item) for item in refreshed.character_classes.prefetch_related("characters").all()],
            "characters": [serialize_character(item) for item in refreshed.characters.prefetch_related("classes").all()],
        }
    )


@api_login_required
@require_http_methods(["DELETE"])
def character_delete_view(request: HttpRequest, project_slug: str, character_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    character = get_object_or_404(Character, project=project, pk=character_id)
    character.delete()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"characters": [serialize_character(item) for item in refreshed.characters.prefetch_related("classes").all()]})


@api_login_required
@require_GET
def stats_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    goal, _ = WritingGoal.objects.get_or_create(project=project)
    revisions = _recent_revision_payload(project, limit=20)
    chapters = list(project.chapters.all())
    chapter_ids = [c.pk for c in chapters]
    summary_map = dict(
        ChapterSummary.objects.filter(chapter_id__in=chapter_ids).values_list("chapter_id", "summary")
    )
    continue_chapter = project.continue_chapter or (chapters[0] if chapters else None)
    overdue = bool(goal.deadline and timezone.localdate() > goal.deadline and project.total_word_count < goal.target_word_count)
    incomplete_chapters = [
        ch
        for ch in chapters
        if ch.word_count < 500 or not (summary_map.get(ch.pk) or "").strip()
    ]
    return JsonResponse(
        {
            "project": serialize_project_detail(project),
            "averageChapterWords": int(project.total_word_count / max(project.chapters.count(), 1)),
            "goal": serialize_writing_goal(goal),
            "revisions": revisions,
            "overview": {
                "continueChapterId": continue_chapter.pk if continue_chapter else None,
                "lastActivityAt": project.latest_activity_at.isoformat() if project.latest_activity_at else None,
                "incompleteChapterCount": len(incomplete_chapters),
                "overdue": overdue,
                "coverReady": bool(
                    getattr(project, "cover_design", None)
                    and (project.cover_design.rendered_cover or project.cover_design.cover_image or project.cover_design.composition)
                ),
            },
        }
    )


@api_login_required
@require_POST
def save_goal_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    goal, _ = WritingGoal.objects.get_or_create(project=project)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    mapped = {
        "target_word_count": payload.get("targetWordCount", goal.target_word_count),
        "daily_target": payload.get("dailyTarget", goal.daily_target),
        "deadline": payload.get("deadline") or None,
    }
    form = WritingGoalForm(mapped, instance=goal)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    goal = form.save()
    return JsonResponse({"goal": serialize_writing_goal(goal)})


@api_login_required
@require_http_methods(["GET", "POST"])
def places_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        return JsonResponse({"places": [serialize_place(p) for p in project.places.all()]})

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    instance = None
    if payload.get("id"):
        instance = get_object_or_404(Place, project=project, pk=payload["id"])
    form = PlaceForm(payload, instance=instance)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    place = form.save(commit=False)
    place.project = project
    place.save()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"places": [serialize_place(p) for p in refreshed.places.all()]})


@api_login_required
@require_http_methods(["DELETE"])
def place_delete_view(request: HttpRequest, project_slug: str, place_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    place = get_object_or_404(Place, project=project, pk=place_id)
    place.delete()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"places": [serialize_place(p) for p in refreshed.places.all()]})


@api_login_required
@require_http_methods(["GET", "POST"])
def research_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        return JsonResponse({"notes": [serialize_research_note(n) for n in project.research_notes.all()]})

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    instance = None
    if payload.get("id"):
        instance = get_object_or_404(ResearchNote, project=project, pk=payload["id"])
    mapped = {
        "title": payload.get("title"),
        "content": payload.get("content"),
        "category": payload.get("category", ""),
        "source_url": payload.get("sourceUrl", payload.get("source_url", "")),
        "pinned": payload.get("pinned", False),
    }
    form = ResearchNoteForm(mapped, instance=instance)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    note = form.save(commit=False)
    note.project = project
    note.save()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"notes": [serialize_research_note(n) for n in refreshed.research_notes.all()]})


@api_login_required
@require_http_methods(["DELETE"])
def research_delete_view(request: HttpRequest, project_slug: str, note_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    note = get_object_or_404(ResearchNote, project=project, pk=note_id)
    note.delete()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"notes": [serialize_research_note(n) for n in refreshed.research_notes.all()]})


@api_login_required
@require_http_methods(["GET", "POST"])
def front_back_matter_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        return JsonResponse({"sections": [serialize_front_back_matter(s) for s in project.front_back_matter.all()]})

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    instance = None
    if payload.get("id"):
        instance = get_object_or_404(FrontBackMatter, project=project, pk=payload["id"])
    mapped = {
        "section_type": payload.get("sectionType", payload.get("section_type")),
        "title": payload.get("title"),
        "content": payload.get("content", ""),
        "position": payload.get("position", 0),
    }
    form = FrontBackMatterForm(mapped, instance=instance)
    if not form.is_valid():
        return JsonResponse({"error": form_errors(form)}, status=400)
    section = form.save(commit=False)
    section.project = project
    section.save()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"sections": [serialize_front_back_matter(s) for s in refreshed.front_back_matter.all()]})


@api_login_required
@require_http_methods(["DELETE"])
def front_back_matter_delete_view(request: HttpRequest, project_slug: str, section_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    section = get_object_or_404(FrontBackMatter, project=project, pk=section_id)
    section.delete()
    refreshed = get_project(request.user, project_slug)
    return JsonResponse({"sections": [serialize_front_back_matter(s) for s in refreshed.front_back_matter.all()]})


@api_login_required
@require_http_methods(["GET"])
def map_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    """Return all map nodes and connections for the project mind-map."""
    project = get_project(request.user, project_slug)
    nodes = list(project.map_nodes.all())
    conns = list(project.connections.select_related("from_node", "to_node").all())
    return JsonResponse({
        "nodes": [serialize_map_node(n) for n in nodes],
        "connections": [serialize_connection(c) for c in conns],
    })


@api_login_required
@require_http_methods(["POST"])
def map_nodes_create_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    """Create a new map node."""
    project = get_project(request.user, project_slug)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    name = (payload.get("name") or "Nouveau nœud").strip()[:140]
    description = payload.get("description", "")
    source_type = (payload.get("sourceType") or "").strip()[:30]
    kind = _normalize_node_kind(payload.get("kind"), source_type)
    color = _normalize_hex_color(payload.get("color"))
    source_id = payload.get("sourceId")
    try:
        pos_x = _coerce_float(payload.get("positionX", 0), "positionX")
        pos_y = _coerce_float(payload.get("positionY", 0), "positionY")
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    # Ensure unique name within project
    base_name = name
    i = 1
    while project.map_nodes.filter(name=name).exists():
        name = f"{base_name} {i}"
        i += 1
    node = MapNode.objects.create(
        project=project,
        name=name,
        description=description,
        position_x=pos_x,
        position_y=pos_y,
        kind=kind,
        color=color,
        source_type=source_type,
        source_id=source_id or None,
    )
    return JsonResponse({"node": serialize_map_node(node)}, status=201)


@api_login_required
@require_http_methods(["PATCH", "DELETE"])
@transaction.atomic
def map_node_detail_view(request: HttpRequest, project_slug: str, node_id: int) -> JsonResponse:
    """Update or delete a map node."""
    project = get_project(request.user, project_slug)
    node = get_object_or_404(MapNode, project=project, pk=node_id)

    if request.method == "DELETE":
        node.delete()
        project.connections.filter(from_node_id=node.pk).delete()
        project.connections.filter(to_node_id=node.pk).delete()
        conns = list(project.connections.select_related("from_node", "to_node").all())
        return JsonResponse({
            "deleted": True,
            "connections": [serialize_connection(c) for c in conns],
        })

    # PATCH
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    old_name = node.name
    new_name = (payload.get("name") or node.name).strip()[:140]
    if new_name != old_name and project.map_nodes.filter(name=new_name).exclude(pk=node.pk).exists():
        return JsonResponse({"error": "Ce nom existe déjà."}, status=400)

    if "name" in payload:
        if new_name != old_name:
            project.connections.filter(from_entity=old_name).update(from_entity=new_name)
            project.connections.filter(to_entity=old_name).update(to_entity=new_name)
            project.connections.filter(from_node=node).update(from_entity=new_name)
            project.connections.filter(to_node=node).update(to_entity=new_name)
        node.name = new_name
    if "description" in payload:
        node.description = payload["description"]
    if "kind" in payload:
        node.kind = _normalize_node_kind(payload.get("kind"), node.source_type)
    if "color" in payload:
        node.color = _normalize_hex_color(payload.get("color"), node.color)
    if "positionX" in payload:
        try:
            node.position_x = _coerce_float(payload["positionX"], "positionX")
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
    if "positionY" in payload:
        try:
            node.position_y = _coerce_float(payload["positionY"], "positionY")
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
    node.save()
    return JsonResponse({"node": serialize_map_node(node)})


@api_login_required
@require_http_methods(["GET", "POST"])
def connections_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    if request.method == "GET":
        all_conns = list(project.connections.select_related("from_node", "to_node").all())
        return JsonResponse({
            "connections": [serialize_connection(c) for c in all_conns],
        })

    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    from_node_id = payload.get("fromNodeId") or payload.get("from_node_id")
    to_node_id = payload.get("toNodeId") or payload.get("to_node_id")
    relationship = (payload.get("label") or payload.get("relationship") or "").strip()
    notes = payload.get("notes", "")

    try:
        from_node = MapNode.objects.get(project=project, pk=from_node_id)
        to_node = MapNode.objects.get(project=project, pk=to_node_id)
    except (MapNode.DoesNotExist, TypeError, ValueError):
        return JsonResponse({"error": "Les deux nœuds sont requis."}, status=400)

    if from_node.pk == to_node.pk:
        return JsonResponse({"error": "Les deux entités doivent être différentes."}, status=400)
    if project.connections.filter(from_node=from_node, to_node=to_node).exists():
        return JsonResponse({"error": "Ce lien existe déjà."}, status=400)

    conn = Connection.objects.create(
        project=project,
        from_node=from_node,
        to_node=to_node,
        from_entity=from_node.name,
        to_entity=to_node.name,
        relationship=relationship,
        notes=notes,
    )
    all_conns = list(project.connections.select_related("from_node", "to_node").all())
    return JsonResponse({
        "connection": serialize_connection(conn),
        "connections": [serialize_connection(c) for c in all_conns],
    }, status=201)


@api_login_required
@require_http_methods(["PATCH", "DELETE"])
def connection_delete_view(request: HttpRequest, project_slug: str, connection_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    conn = get_object_or_404(Connection.objects.select_related("from_node", "to_node"), project=project, pk=connection_id)
    if request.method == "PATCH":
        try:
            payload = json_body(request)
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        if "label" in payload or "relationship" in payload:
            conn.relationship = (payload.get("label") or payload.get("relationship") or "").strip()
        if "notes" in payload:
            conn.notes = payload.get("notes") or ""
        if "fromNodeId" in payload or "toNodeId" in payload:
            try:
                from_node = MapNode.objects.get(project=project, pk=payload.get("fromNodeId", conn.from_node_id))
                to_node = MapNode.objects.get(project=project, pk=payload.get("toNodeId", conn.to_node_id))
            except (MapNode.DoesNotExist, TypeError, ValueError):
                return JsonResponse({"error": "Impossible de reconnecter ce lien."}, status=400)
            if from_node.pk == to_node.pk:
                return JsonResponse({"error": "Les deux entités doivent être différentes."}, status=400)
            duplicate = project.connections.filter(from_node=from_node, to_node=to_node).exclude(pk=conn.pk).exists()
            if duplicate:
                return JsonResponse({"error": "Ce lien existe déjà."}, status=400)
            conn.from_node = from_node
            conn.to_node = to_node
            conn.from_entity = from_node.name
            conn.to_entity = to_node.name
        conn.save()
        return JsonResponse({"connection": serialize_connection(conn)})

    conn.delete()
    all_conns = list(project.connections.select_related("from_node", "to_node").all())
    return JsonResponse({
        "connections": [serialize_connection(c) for c in all_conns],
    })


@api_login_required
@require_POST
def map_import_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    try:
        payload = json_body(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    source_type = (payload.get("sourceType") or "").strip()
    mapping = {
        "characters": project.characters.all(),
        "places": project.places.all(),
        "chapters": project.chapters.select_related("summary").all(),
    }
    if source_type not in mapping:
        return JsonResponse({"error": "Type d'import invalide."}, status=400)

    created = []
    for item in mapping[source_type]:
        source_id = item.pk
        if project.map_nodes.filter(source_type=source_type, source_id=source_id).exists():
            continue
        if source_type == "chapters":
            summary_obj = getattr(item, "summary", None)
            description = getattr(summary_obj, "summary", "") or getattr(item, "plain_text", "")[:220]
        else:
            description = getattr(item, "summary", "") or getattr(item, "description", "") or ""
        node = MapNode.objects.create(
            project=project,
            name=getattr(item, "name", getattr(item, "title", "Nœud")),
            description=description,
            position_x=120 + (len(created) % 4) * 170,
            position_y=140 + (len(created) // 4) * 120,
            kind=_normalize_node_kind(None, source_type),
            color={
                "characters": "#6ba8d4",
                "places": "#6bc490",
                "chapters": "#c49a6c",
            }.get(source_type, "#c49a6c"),
            source_type=source_type,
            source_id=source_id,
        )
        created.append(node)

    return JsonResponse({"nodes": [serialize_map_node(node) for node in created]}, status=201)


def _search_snippet(text: str, idx: int, q_len: int, radius: int = 72) -> str:
    if idx < 0:
        clip = text[: radius * 2]
        return clip + ("…" if len(text) > len(clip) else "")
    start = max(0, idx - radius)
    end = min(len(text), idx + q_len + radius)
    return ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")


@api_login_required
@require_GET
def search_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    raw_q = (request.GET.get("q") or "").strip()
    q_lower = raw_q.lower()
    if not q_lower or len(q_lower) < 2:
        return JsonResponse({"results": [], "query": raw_q})

    results: list[dict] = []
    from django.utils.html import strip_tags

    def push(
        *,
        kind: str,
        pk: int,
        title: str,
        url: str,
        snippet: str,
        chapter_id: int | None = None,
        match_offset: int | None = None,
        meta: str | None = None,
    ) -> None:
        results.append({
            "type": kind,
            "id": pk,
            "title": title,
            "url": url,
            "snippet": snippet[:400],
            "chapterId": chapter_id,
            "matchOffset": match_offset,
            "meta": meta,
        })

    slug = project.slug
    for chapter in project.chapters.all():
        plain = strip_tags(chapter.content or "")
        plain_l = plain.lower()
        title_l = chapter.title.lower()
        if q_lower in title_l:
            t_idx = title_l.find(q_lower)
            push(
                kind="chapter_title",
                pk=chapter.pk,
                title=chapter.title,
                url=f"/projects/{slug}/workspace/{chapter.pk}/?highlight={raw_q}",
                snippet=_search_snippet(chapter.title, t_idx, len(raw_q)),
                chapter_id=chapter.pk,
                match_offset=t_idx,
                meta="Titre de chapitre",
            )
        elif q_lower in plain_l:
            idx = plain_l.find(q_lower)
            push(
                kind="chapter",
                pk=chapter.pk,
                title=chapter.title,
                url=f"/projects/{slug}/workspace/{chapter.pk}/?highlight={raw_q}",
                snippet=_search_snippet(plain, idx, len(raw_q)),
                chapter_id=chapter.pk,
                match_offset=idx,
                meta="Chapitre",
            )

    for note in ChapterNote.objects.filter(chapter__project=project).select_related("chapter"):
        blob = f"{note.title}\n{note.body}"
        blob_l = blob.lower()
        if q_lower in blob_l:
            idx = blob_l.find(q_lower)
            push(
                kind="note",
                pk=note.pk,
                title=note.title or "Note",
                url=f"/projects/{slug}/workspace/{note.chapter_id}/",
                snippet=_search_snippet(blob, idx, len(raw_q)),
                chapter_id=note.chapter_id,
                match_offset=idx,
                meta="Note",
            )

    for entry in project.dictionary_entries.all():
        blob = f"{entry.term}\n{entry.definition}\n{entry.usage_notes or ''}"
        blob_l = blob.lower()
        if q_lower in blob_l:
            idx = blob_l.find(q_lower)
            push(
                kind="dictionary",
                pk=entry.pk,
                title=entry.term,
                url=f"/projects/{slug}/dictionary/",
                snippet=_search_snippet(blob.replace("\n", " "), idx, len(raw_q)),
                meta="Dictionnaire",
            )

    for ch in project.characters.all():
        blob = " ".join(
            x
            for x in (ch.name, ch.role, ch.summary, ch.appearance, ch.goals, ch.conflicts, ch.notes)
            if x
        )
        blob_l = blob.lower()
        if q_lower in blob_l:
            idx = blob_l.find(q_lower)
            push(
                kind="character",
                pk=ch.pk,
                title=ch.name,
                url=f"/projects/{slug}/characters/",
                snippet=_search_snippet(blob, idx, len(raw_q)),
                meta="Personnage",
            )

    for pl in project.places.all():
        blob = " ".join(
            x
            for x in (pl.name, pl.description, pl.significance, pl.history, pl.geography, pl.culture, pl.notes)
            if x
        )
        blob_l = blob.lower()
        if q_lower in blob_l:
            idx = blob_l.find(q_lower)
            push(
                kind="place",
                pk=pl.pk,
                title=pl.name,
                url=f"/projects/{slug}/places/",
                snippet=_search_snippet(blob, idx, len(raw_q)),
                meta="Lieu",
            )

    for rn in project.research_notes.all():
        blob = f"{rn.title}\n{rn.content}\n{rn.category or ''}"
        blob_l = blob.lower()
        if q_lower in blob_l:
            idx = blob_l.find(q_lower)
            push(
                kind="research",
                pk=rn.pk,
                title=rn.title,
                url=f"/projects/{slug}/research/",
                snippet=_search_snippet(blob.replace("\n", " "), idx, len(raw_q)),
                meta="Documentation",
            )

    return JsonResponse({"results": results, "query": raw_q})


@api_login_required
@require_GET
def export_view(request: HttpRequest, project_slug: str) -> HttpResponse | JsonResponse:
    project = get_project(request.user, project_slug)
    fmt = request.GET.get("format", "text")
    safe_title = project.slug or "manuscript"
    cover_design = getattr(project, "cover_design", None)

    if cover_design:
        update_fields = _ensure_cover_render(cover_design)
        if update_fields:
            cover_design.save(update_fields=update_fields)

    try:
        if fmt == "html":
            preview = request.GET.get("preview") in {"1", "true", "yes"}
            return JsonResponse({"format": "html", "content": export_html(project, preview=preview), "title": project.title})

        if fmt == "epub":
            response = HttpResponse(export_epub(project), content_type="application/epub+zip")
            response["Content-Disposition"] = f'attachment; filename="{safe_title}.epub"'
            return response

        if fmt == "pdf":
            base_url = request.build_absolute_uri("/")
            response = HttpResponse(export_pdf(project, base_url=base_url), content_type="application/pdf")
            response["Content-Disposition"] = f'attachment; filename="{safe_title}.pdf"'
            return response

        return JsonResponse({"format": "text", "content": export_text(project), "title": project.title})

    except RuntimeError as exc:
        return JsonResponse({"error": str(exc)}, status=501)
    except (OSError, IOError, ValueError, MemoryError) as exc:
        return JsonResponse({"error": f"Export failed: {exc}"}, status=500)
    except Exception as exc:  # noqa: BLE001 – catch-all for unexpected library errors
        return JsonResponse({"error": f"Export error: {type(exc).__name__}: {exc}"}, status=500)


@api_login_required
@require_GET
def revision_detail_view(request: HttpRequest, project_slug: str, revision_id: int) -> JsonResponse:
    project = get_project(request.user, project_slug)
    revision = get_object_or_404(
        ChapterRevision.objects.select_related("chapter"),
        chapter__project=project,
        pk=revision_id,
    )
    return JsonResponse({
        "revision": {
            "id": revision.pk,
            "chapterId": revision.chapter.pk,
            "chapterTitle": revision.chapter.title,
            "title": revision.title,
            "content": revision.content,
            "wordCount": revision.word_count,
            "characterCount": revision.character_count,
            "source": revision.source,
            "createdAt": revision.created_at.isoformat(),
        }
    })


@api_login_required
@require_GET
def structure_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    chapters = []
    for chapter in project.chapters.all():
        summary_obj = getattr(chapter, "summary", None)
        if summary_obj is None:
            try:
                summary_obj = ChapterSummary.objects.get(chapter=chapter)
            except ChapterSummary.DoesNotExist:
                summary_obj = None
        chapters.append({
            "id": chapter.pk,
            "title": chapter.title,
            "position": chapter.position,
            "wordCount": chapter.word_count,
            "characterCount": chapter.character_count,
            "summary": summary_obj.summary if summary_obj else "",
            "lastAutosavedAt": chapter.last_autosaved_at.isoformat() if chapter.last_autosaved_at else None,
        })
    return JsonResponse({
        "project": serialize_project_detail(project),
        "chapters": chapters,
    })


# ── Cover Designer ────────────────────────────────────────────────────────────

def _serialize_cover(cover: CoverDesign) -> dict:
    composition = normalize_cover_composition(cover.composition or default_cover_composition(cover), cover)
    template_id = _infer_cover_template_id(cover)
    editor_mode = _normalize_cover_editor_mode(cover.editor_mode)
    return {
        "id": cover.pk,
        "coverImageUrl": serialize_media_url(cover.cover_image, cover.updated_at.timestamp()),
        "customCoverUrl": serialize_media_url(cover.custom_cover, cover.updated_at.timestamp()),
        "displayMode": cover.display_mode,
        "editorMode": editor_mode,
        "templateId": template_id,
        "bgColor": cover.bg_color,
        "titleText": cover.title_text,
        "titleFont": cover.title_font,
        "titleSize": cover.title_size,
        "titleColor": cover.title_color,
        "subtitleText": cover.subtitle_text,
        "subtitleFont": cover.subtitle_font,
        "subtitleSize": cover.subtitle_size,
        "subtitleColor": cover.subtitle_color,
        "authorText": cover.author_text,
        "authorFont": cover.author_font,
        "authorSize": cover.author_size,
        "authorColor": cover.author_color,
        "layers": cover.layers,
        "composition": composition,
        "renderedCoverUrl": serialize_media_url(cover.rendered_cover, cover.updated_at.timestamp()),
    }


@api_login_required
@require_http_methods(["GET", "POST"])
def cover_design_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    cover, _ = CoverDesign.objects.get_or_create(
        project=project,
        defaults={
            "title_text": project.title,
            "author_text": _cover_author_name(project),
            "editor_mode": "generated",
            "template_id": "editorial-night",
            "layers": [
                {"id": "background", "type": "background", "label": "Image de fond", "visible": True},
                {"id": "title", "type": "text", "label": "Titre / Sous-titre", "visible": True},
                {"id": "author", "type": "text", "label": "Auteur", "visible": True},
            ],
        },
    )
    update_fields = _ensure_cover_render(cover)
    if update_fields:
        cover.save(update_fields=update_fields)

    if request.method == "GET":
        return JsonResponse({"cover": _serialize_cover(cover)})

    # POST – update fields
    try:
        data = json_body(request) if request.content_type == "application/json" else request.POST.dict()
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    # Handle image removal
    if data.get("removeCoverImage"):
        if cover.cover_image:
            _delete_file_if_present(cover.cover_image)
            cover.cover_image = None
            if cover.editor_mode == "upload":
                cover.editor_mode = "generated"
            cover.display_mode = "artwork"
            cover.composition = normalize_cover_composition(cover.composition, cover)
            for layer in cover.composition["layers"]:
                if layer["type"] == "background":
                    layer["imageUrl"] = ""
            _save_cover_render(cover)
            cover.save(update_fields=["cover_image", "editor_mode", "display_mode", "composition", "rendered_cover", "updated_at"])
        return JsonResponse({"cover": _serialize_cover(cover)})

    if data.get("removeCustomCover"):
        if cover.custom_cover:
            _delete_file_if_present(cover.custom_cover)
            cover.custom_cover = None
            if cover.editor_mode == "upload":
                cover.editor_mode = "generated"
            _save_cover_render(cover)
            cover.save(update_fields=["custom_cover", "editor_mode", "rendered_cover", "updated_at"])
        return JsonResponse({"cover": _serialize_cover(cover)})

    updatable_fields = {
        "editor_mode": "editorMode",
        "template_id": "templateId",
        "bg_color": "bgColor",
        "title_text": "titleText",
        "title_font": "titleFont",
        "title_size": "titleSize",
        "title_color": "titleColor",
        "subtitle_text": "subtitleText",
        "subtitle_font": "subtitleFont",
        "subtitle_size": "subtitleSize",
        "subtitle_color": "subtitleColor",
        "author_text": "authorText",
        "author_font": "authorFont",
        "author_size": "authorSize",
        "author_color": "authorColor",
        "layers": "layers",
    }
    changed = False
    if "displayMode" in data:
        display_mode = data.get("displayMode")
        normalized_mode = display_mode if display_mode in ("artwork", "full") else "artwork"
        if cover.display_mode != normalized_mode:
            cover.display_mode = normalized_mode
            changed = True
    for model_field, json_key in updatable_fields.items():
        if json_key in data:
            value = data[json_key]
            if model_field == "editor_mode":
                value = _normalize_cover_editor_mode(value)
            if model_field == "layers":
                try:
                    value = _sanitize_cover_layers(value)
                except (TypeError, ValueError) as exc:
                    return JsonResponse({"error": str(exc)}, status=400)
            if model_field in {"title_size", "subtitle_size", "author_size"}:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    return JsonResponse({"error": f"Invalid value for {json_key}."}, status=400)
                value = max(8, min(160, value))
            setattr(cover, model_field, value)
            changed = True
    if "composition" in data:
        try:
            cover.composition = normalize_cover_composition(data.get("composition"), cover)
        except (TypeError, ValueError) as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        changed = True

    if changed:
        if not cover.composition:
            cover.composition = default_cover_composition(cover)
        if cover.editor_mode == "upload":
            cover.display_mode = "full"
        _save_cover_render(cover)
        cover.save()

    return JsonResponse({"cover": _serialize_cover(cover)})


@api_login_required
@require_POST
def cover_upload_image_view(request: HttpRequest, project_slug: str) -> JsonResponse:
    project = get_project(request.user, project_slug)
    cover, _ = CoverDesign.objects.get_or_create(project=project)

    image_file = request.FILES.get("image")
    if not image_file:
        return JsonResponse({"error": "No image file provided."}, status=400)

    # Validate content type
    allowed = {"image/jpeg", "image/png", "image/svg+xml", "image/webp"}
    if image_file.content_type not in allowed:
        return JsonResponse({"error": "Unsupported image type."}, status=400)

    # Validate size (max 5 MB)
    if image_file.size > 5 * 1024 * 1024:
        return JsonResponse({"error": "Image too large (max 5 MB)."}, status=400)

    target = request.POST.get("target") or "background"
    ext = image_file.name.rsplit(".", 1)[-1].lower() if "." in image_file.name else "jpg"
    folder = "covers/custom" if target == "custom" else "covers"
    filename = f"{folder}/{project.slug}-{uuid.uuid4().hex[:8]}.{ext}"
    path = default_storage.save(filename, image_file)
    if target == "custom":
        if cover.custom_cover:
            _delete_file_if_present(cover.custom_cover)
        cover.custom_cover = path
        cover.editor_mode = "upload"
        cover.display_mode = "full"
        _save_cover_render(cover)
        cover.save(update_fields=["custom_cover", "editor_mode", "display_mode", "rendered_cover", "updated_at"])
        return JsonResponse({"url": default_storage.url(path), "cover": _serialize_cover(cover)})

    if cover.cover_image:
        _delete_file_if_present(cover.cover_image)
    cover.cover_image = path
    cover.editor_mode = "generated"
    display_mode = request.POST.get("display_mode") or request.POST.get("displayMode") or "artwork"
    cover.display_mode = display_mode if display_mode in ("artwork", "full") else "artwork"
    cover.composition = normalize_cover_composition(cover.composition or default_cover_composition(cover), cover)
    background_layer = next((layer for layer in cover.composition["layers"] if layer["type"] == "background"), None)
    if background_layer:
        background_layer["imageUrl"] = default_storage.url(path)
    else:
        cover.composition["layers"].insert(
            0,
            {
                "id": "bg",
                "type": "background",
                "x": 0,
                "y": 0,
                "w": 100,
                "h": 100,
                "color": cover.bg_color,
                "imageUrl": default_storage.url(path),
                "fit": "cover",
                "opacity": 1,
                "locked": True,
                "visible": True,
                "zIndex": 0,
            },
        )
    _save_cover_render(cover)
    update_fields = ["cover_image", "editor_mode", "display_mode", "composition", "rendered_cover", "updated_at"]
    cover.save(update_fields=update_fields)

    return JsonResponse({"url": default_storage.url(path), "cover": _serialize_cover(cover)})
