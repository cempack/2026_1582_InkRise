from django.contrib.auth.models import AbstractUser

from .models import (
    Chapter,
    Character,
    CharacterClass,
    ChapterSummary,
    Connection,
    FrontBackMatter,
    MapNode,
    Place,
    Profile,
    Project,
    ProjectDictionaryEntry,
    ResearchNote,
    WritingGoal,
)


def serialize_media_url(file_field, version=None) -> str | None:
    if not file_field:
        return None
    url = file_field.url
    if not version:
        return url
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}v={version}"


def _cover_primary_asset_url(cover_design) -> str | None:
    if not cover_design:
        return None
    version = cover_design.updated_at.timestamp()
    if cover_design.editor_mode == "upload" and cover_design.custom_cover:
        return serialize_media_url(cover_design.custom_cover, version)
    if cover_design.rendered_cover:
        return serialize_media_url(cover_design.rendered_cover, version)
    if cover_design.cover_image:
        return serialize_media_url(cover_design.cover_image, version)
    return None


def serialize_profile(profile: Profile) -> dict:
    return {
        "penName": profile.pen_name,
        "bio": profile.bio,
        "avatarUrl": profile.avatar.url if profile.avatar else None,
        "defaultFontFamily": profile.default_font_family,
        "defaultFontSize": profile.default_font_size,
        "defaultLineHeight": profile.default_line_height,
        "defaultContentWidth": profile.default_content_width,
        "uiTheme": profile.ui_theme,
        "uiAccent": profile.ui_accent or None,
    }


def serialize_user(user: AbstractUser) -> dict:
    return {
        "username": user.username,
        "firstName": user.first_name,
        "email": user.email,
        "isStaff": user.is_staff,
        "profile": serialize_profile(user.profile),
    }


def serialize_project_summary(project: Project) -> dict:
    first_chapter = project.chapters.first()
    continue_chapter = project.continue_chapter
    cover_design = getattr(project, "cover_design", None)
    cover_thumbnail = _cover_primary_asset_url(cover_design)
    return {
        "title": project.title,
        "slug": project.slug,
        "logline": project.logline,
        "description": project.description,
        "genre": project.genre,
        "accentColor": project.accent_color,
        "chapterCount": project.chapters.count(),
        "totalWordCount": project.total_word_count,
        "totalCharacterCount": project.total_character_count,
        "firstChapterId": first_chapter.pk if first_chapter else None,
        "continueChapterId": continue_chapter.pk if continue_chapter else (first_chapter.pk if first_chapter else None),
        "coverThumbnailUrl": cover_thumbnail,
        "lastActivityAt": project.latest_activity_at.isoformat() if project.latest_activity_at else None,
        "updatedAt": project.updated_at.isoformat(),
    }


def serialize_chapter_item(chapter: Chapter) -> dict:
    return {
        "id": chapter.pk,
        "title": chapter.title,
        "slug": chapter.slug,
        "position": chapter.position,
        "wordCount": chapter.word_count,
        "characterCount": chapter.character_count,
        "lastAutosavedAt": chapter.last_autosaved_at.isoformat() if chapter.last_autosaved_at else None,
    }


def serialize_note(note) -> dict:
    return {
        "id": note.pk,
        "title": note.title,
        "body": note.body,
        "pinned": note.pinned,
        "updatedAt": note.updated_at.isoformat(),
    }


def serialize_dictionary_entry(entry: ProjectDictionaryEntry) -> dict:
    return {
        "id": entry.pk,
        "term": entry.term,
        "definition": entry.definition,
        "usageNotes": entry.usage_notes,
        "updatedAt": entry.updated_at.isoformat(),
    }


def serialize_character_class(character_class: CharacterClass) -> dict:
    return {
        "id": character_class.pk,
        "name": character_class.name,
        "description": character_class.description,
        "characterCount": character_class.characters.count(),
    }


def serialize_character(character: Character) -> dict:
    return {
        "id": character.pk,
        "name": character.name,
        "role": character.role,
        "avatarUrl": character.avatar.url if character.avatar else None,
        "firstName": character.first_name,
        "lastName": character.last_name,
        "nickname": character.nickname,
        "pronouns": character.pronouns,
        "sexOrGender": character.sex_or_gender,
        "species": character.species,
        "age": character.age,
        "birthDate": character.birth_date.isoformat() if character.birth_date else None,
        "birthPlace": character.birth_place,
        "residence": character.residence,
        "occupation": character.occupation,
        "summary": character.summary,
        "appearance": character.appearance,
        "personality": character.personality,
        "backstory": character.backstory,
        "evolution": character.evolution,
        "goals": character.goals,
        "conflicts": character.conflicts,
        "inventory": character.inventory,
        "possessions": character.possessions,
        "extras": character.extras,
        "notes": character.notes,
        "starRating": character.star_rating,
        "classIds": list(character.classes.values_list("pk", flat=True)),
        "classNames": list(character.classes.values_list("name", flat=True)),
        "updatedAt": character.updated_at.isoformat(),
    }


def serialize_place(place: Place) -> dict:
    return {
        "id": place.pk,
        "name": place.name,
        "description": place.description,
        "significance": place.significance,
        "history": place.history,
        "geography": place.geography,
        "culture": place.culture,
        "notes": place.notes,
        "updatedAt": place.updated_at.isoformat(),
    }


def serialize_research_note(note: ResearchNote) -> dict:
    return {
        "id": note.pk,
        "title": note.title,
        "content": note.content,
        "category": note.category,
        "sourceUrl": note.source_url,
        "pinned": note.pinned,
        "updatedAt": note.updated_at.isoformat(),
    }


def serialize_writing_goal(goal: WritingGoal) -> dict:
    return {
        "id": goal.pk,
        "targetWordCount": goal.target_word_count,
        "dailyTarget": goal.daily_target,
        "deadline": goal.deadline.isoformat() if goal.deadline else None,
    }


def serialize_front_back_matter(section: FrontBackMatter) -> dict:
    return {
        "id": section.pk,
        "sectionType": section.section_type,
        "sectionTypeDisplay": section.get_section_type_display(),
        "title": section.title,
        "content": section.content,
        "position": section.position,
        "updatedAt": section.updated_at.isoformat(),
    }


def serialize_map_node(node: MapNode) -> dict:
    return {
        "id": node.pk,
        "name": node.name,
        "description": node.description,
        "positionX": node.position_x,
        "positionY": node.position_y,
        "kind": node.kind,
        "color": node.color,
        "sourceType": node.source_type,
        "sourceId": node.source_id,
    }


def serialize_connection(conn: Connection) -> dict:
    return {
        "id": conn.pk,
        "fromNodeId": conn.from_node_id,
        "toNodeId": conn.to_node_id,
        "fromEntity": conn.from_node.name if conn.from_node else conn.from_entity,
        "toEntity": conn.to_node.name if conn.to_node else conn.to_entity,
        "label": conn.relationship,
        "relationship": conn.relationship,
        "notes": conn.notes,
        "updatedAt": conn.updated_at.isoformat(),
    }


def serialize_project_detail(project: Project) -> dict:
    continue_chapter = project.continue_chapter
    cover_design = getattr(project, "cover_design", None)
    return {
        "title": project.title,
        "slug": project.slug,
        "logline": project.logline,
        "description": project.description,
        "genre": project.genre,
        "accentColor": project.accent_color,
        "formatting": {
            "fontFamily": project.manuscript_font_family,
            "fontSize": project.manuscript_font_size,
            "lineHeight": project.manuscript_line_height,
            "manuscriptWidth": project.manuscript_width,
        },
        "chapters": [serialize_chapter_item(chapter) for chapter in project.chapters.all()],
        "continueChapterId": continue_chapter.pk if continue_chapter else None,
        "lastActivityAt": project.latest_activity_at.isoformat() if project.latest_activity_at else None,
        "cover": {
            "thumbnailUrl": _cover_primary_asset_url(cover_design),
        },
        "dictionaryPreview": [serialize_dictionary_entry(entry) for entry in project.dictionary_entries.all()[:8]],
        "characterClassCount": project.character_classes.count(),
        "characterCount": project.characters.count(),
        "stats": {
            "totalWordCount": project.total_word_count,
            "totalCharacterCount": project.total_character_count,
            "chapterCount": project.chapters.count(),
        },
    }


def serialize_workspace(project: Project, chapter: Chapter) -> dict:
    try:
        summary_text = chapter.summary.summary or ""
    except ChapterSummary.DoesNotExist:
        summary_text = ""
    return {
        "project": serialize_project_detail(project),
        "dictionaryGlossary": [
            serialize_dictionary_entry(entry) for entry in project.dictionary_entries.all()
        ],
        "currentChapter": {
            "id": chapter.pk,
            "title": chapter.title,
            "content": chapter.content,
            "wordCount": chapter.word_count,
            "characterCount": chapter.character_count,
            "summary": summary_text,
            "notes": [serialize_note(note) for note in chapter.notes.all()],
        },
        "recentRevisions": [
            {
                "id": revision.pk,
                "title": revision.title,
                "source": revision.source,
                "wordCount": revision.word_count,
                "createdAt": revision.created_at.isoformat(),
            }
            for revision in chapter.revisions.all()[:8]
        ],
    }
