from django.contrib import admin
from .models import (
    Chapter,
    ChapterNote,
    ChapterRevision,
    ChapterSummary,
    Character,
    CharacterClass,
    Profile,
    Project,
    ProjectDictionaryEntry,
)


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "pen_name", "default_font_family")
    search_fields = ("user__username", "pen_name")


class ChapterInline(admin.TabularInline):
    model = Chapter
    extra = 0
    fields = ("title", "position", "word_count", "updated_at")


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("title", "user", "genre", "updated_at")
    list_filter = ("genre",)
    search_fields = ("title", "user__username")
    inlines = [ChapterInline]


@admin.register(Chapter)
class ChapterAdmin(admin.ModelAdmin):
    list_display = ("title", "project", "position", "word_count", "last_autosaved_at")
    list_filter = ("project",)
    search_fields = ("title", "project__title")


@admin.register(ChapterRevision)
class ChapterRevisionAdmin(admin.ModelAdmin):
    list_display = ("chapter", "source", "word_count", "created_at")
    list_filter = ("source",)


@admin.register(ChapterSummary)
class ChapterSummaryAdmin(admin.ModelAdmin):
    list_display = ("chapter", "updated_at")


@admin.register(ProjectDictionaryEntry)
class DictionaryEntryAdmin(admin.ModelAdmin):
    list_display = ("term", "project", "updated_at")
    search_fields = ("term", "definition")


@admin.register(ChapterNote)
class ChapterNoteAdmin(admin.ModelAdmin):
    list_display = ("title", "chapter", "pinned", "updated_at")
    list_filter = ("pinned",)


@admin.register(CharacterClass)
class CharacterClassAdmin(admin.ModelAdmin):
    list_display = ("name", "project", "updated_at")


@admin.register(Character)
class CharacterAdmin(admin.ModelAdmin):
    list_display = ("name", "project", "role", "updated_at")
    search_fields = ("name", "role")
