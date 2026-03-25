import re
import unicodedata

from django.conf import settings
from django.db import models
from django.db.models import Max
from django.template.defaultfilters import slugify
from django.utils import timezone
from django.utils.html import strip_tags


WORD_TOKEN_RE = re.compile(
    r"[^\W_]+(?:[’'][^\W_]+)*(?:-[^\W_]+(?:[’'][^\W_]+)*)*",
    re.UNICODE,
)


def count_words(text: str) -> int:
    normalized = unicodedata.normalize("NFKC", text or "")
    normalized = normalized.replace("\u2019", "'")
    normalized = re.sub(r"[‐‑‒–—―]+", " ", normalized)
    normalized = re.sub(r"-{2,}", " ", normalized)
    return len(WORD_TOKEN_RE.findall(normalized))


def unique_slug_for(instance, value: str, queryset, slug_field: str = "slug") -> str:
    base_slug = slugify(value)[:45] or "item"
    slug = base_slug
    counter = 2
    while queryset.exclude(pk=instance.pk).filter(**{slug_field: slug}).exists():
        slug = f"{base_slug[:40]}-{counter}"
        counter += 1
    return slug


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Profile(TimeStampedModel):
    FONT_CHOICES = [
        ("serif", "Serif"),
        ("sans", "Sans"),
        ("mono", "Mono"),
    ]
    UI_THEME_CHOICES = [
        ("system", "Système"),
        ("light", "Clair"),
        ("dark", "Sombre"),
    ]

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile")
    pen_name = models.CharField(max_length=120, blank=True)
    bio = models.TextField(blank=True)
    avatar = models.ImageField(upload_to="avatars/", blank=True, null=True)
    default_font_family = models.CharField(max_length=20, choices=FONT_CHOICES, default="serif")
    default_font_size = models.PositiveSmallIntegerField(default=18)
    default_line_height = models.FloatField(default=1.8)
    default_content_width = models.PositiveSmallIntegerField(default=820)
    ui_theme = models.CharField(max_length=16, choices=UI_THEME_CHOICES, default="system")
    ui_accent = models.CharField(max_length=7, blank=True, help_text="Couleur d’accent (#RRGGBB). Vide = thème par défaut.")

    def __str__(self) -> str:
        return self.pen_name or self.user.get_username()


class Project(TimeStampedModel):
    FONT_CHOICES = Profile.FONT_CHOICES

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="projects")
    title = models.CharField(max_length=160)
    slug = models.SlugField(max_length=55, unique=True, blank=True)
    logline = models.CharField(max_length=240, blank=True)
    description = models.TextField(blank=True)
    genre = models.CharField(max_length=120, blank=True)
    accent_color = models.CharField(max_length=7, default="#7c6cf2")
    manuscript_font_family = models.CharField(max_length=20, choices=FONT_CHOICES, default="serif")
    manuscript_font_size = models.PositiveSmallIntegerField(default=18)
    manuscript_line_height = models.FloatField(default=1.8)
    manuscript_width = models.PositiveSmallIntegerField(default=820)

    class Meta:
        ordering = ["-updated_at", "-created_at"]

    def __str__(self) -> str:
        return self.title

    @property
    def total_word_count(self) -> int:
        return sum(chapter.word_count for chapter in self.chapters.all())

    @property
    def total_character_count(self) -> int:
        return sum(chapter.character_count for chapter in self.chapters.all())

    def apply_profile_defaults(self, profile: "Profile") -> None:
        self.manuscript_font_family = profile.default_font_family
        self.manuscript_font_size = profile.default_font_size
        self.manuscript_line_height = profile.default_line_height
        self.manuscript_width = profile.default_content_width

    @property
    def continue_chapter(self) -> "Chapter | None":
        chapters = list(self.chapters.all())
        if not chapters:
            return None
        return max(
            chapters,
            key=lambda chapter: (
                chapter.last_autosaved_at or chapter.updated_at,
                chapter.position,
            ),
        )

    @property
    def latest_activity_at(self):
        chapter = self.continue_chapter
        if chapter:
            return chapter.last_autosaved_at or chapter.updated_at
        return self.updated_at

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = unique_slug_for(self, self.title, Project.objects.all())
        super().save(*args, **kwargs)


class Chapter(TimeStampedModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="chapters")
    title = models.CharField(max_length=160)
    slug = models.SlugField(max_length=55, blank=True)
    position = models.PositiveIntegerField(default=0, db_index=True)
    content = models.TextField(blank=True)
    word_count = models.PositiveIntegerField(default=0)
    character_count = models.PositiveIntegerField(default=0)
    last_autosaved_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["position", "created_at"]

    def __str__(self) -> str:
        return f"{self.project.title}: {self.title}"

    @property
    def plain_text(self) -> str:
        return " ".join(strip_tags(self.content or "").split())

    def recalculate_counts(self) -> None:
        text = self.plain_text
        self.word_count = count_words(text)
        self.character_count = len(text)

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = unique_slug_for(
                self,
                self.title,
                Chapter.objects.filter(project=self.project),
            )
        if not self.position:
            highest = self.project.chapters.aggregate(max_position=Max("position")).get("max_position") or 0
            self.position = highest + 1
        self.recalculate_counts()
        super().save(*args, **kwargs)

    def touch_autosave(self) -> None:
        self.last_autosaved_at = timezone.now()


class ChapterRevision(models.Model):
    SOURCE_CHOICES = [
        ("autosave", "Autosave"),
        ("manual", "Manual"),
    ]

    chapter = models.ForeignKey(Chapter, on_delete=models.CASCADE, related_name="revisions")
    title = models.CharField(max_length=160)
    content = models.TextField(blank=True)
    word_count = models.PositiveIntegerField(default=0)
    character_count = models.PositiveIntegerField(default=0)
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES, default="autosave")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.chapter.title} ({self.source})"


class ChapterSummary(TimeStampedModel):
    chapter = models.OneToOneField(Chapter, on_delete=models.CASCADE, related_name="summary")
    summary = models.TextField(blank=True)

    def __str__(self) -> str:
        return f"Summary for {self.chapter.title}"


class ProjectDictionaryEntry(TimeStampedModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="dictionary_entries")
    term = models.CharField(max_length=120)
    definition = models.TextField()
    usage_notes = models.CharField(max_length=240, blank=True)

    class Meta:
        ordering = ["term", "created_at"]

    def __str__(self) -> str:
        return self.term


class ChapterNote(TimeStampedModel):
    chapter = models.ForeignKey(Chapter, on_delete=models.CASCADE, related_name="notes")
    title = models.CharField(max_length=120)
    body = models.TextField()
    pinned = models.BooleanField(default=False)

    class Meta:
        ordering = ["-pinned", "-updated_at", "-created_at"]

    def __str__(self) -> str:
        return self.title


class CharacterClass(TimeStampedModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="character_classes")
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name", "created_at"]

    def __str__(self) -> str:
        return self.name


class Character(TimeStampedModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="characters")
    classes = models.ManyToManyField(CharacterClass, blank=True, related_name="characters")
    avatar = models.ImageField(upload_to="character_avatars/", blank=True, null=True)
    name = models.CharField(max_length=140)
    role = models.CharField(max_length=160, blank=True)
    first_name = models.CharField(max_length=80, blank=True)
    last_name = models.CharField(max_length=80, blank=True)
    nickname = models.CharField(max_length=120, blank=True)
    pronouns = models.CharField(max_length=80, blank=True)
    sex_or_gender = models.CharField(max_length=80, blank=True)
    species = models.CharField(max_length=120, blank=True)
    age = models.PositiveSmallIntegerField(blank=True, null=True)
    birth_date = models.DateField(blank=True, null=True)
    birth_place = models.CharField(max_length=160, blank=True)
    residence = models.CharField(max_length=160, blank=True)
    occupation = models.CharField(max_length=160, blank=True)
    summary = models.TextField(blank=True)
    appearance = models.TextField(blank=True)
    personality = models.TextField(blank=True)
    backstory = models.TextField(blank=True)
    evolution = models.TextField(blank=True)
    goals = models.TextField(blank=True)
    conflicts = models.TextField(blank=True)
    inventory = models.TextField(blank=True)
    possessions = models.TextField(blank=True)
    extras = models.TextField(blank=True)
    notes = models.TextField(blank=True)
    star_rating = models.PositiveSmallIntegerField(default=3)

    class Meta:
        ordering = ["name", "created_at"]

    def __str__(self) -> str:
        return self.name


class Place(TimeStampedModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="places")
    name = models.CharField(max_length=140)
    description = models.TextField(blank=True)
    significance = models.TextField(blank=True)
    history = models.TextField(blank=True)
    geography = models.TextField(blank=True)
    culture = models.TextField(blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["name", "created_at"]

    def __str__(self) -> str:
        return self.name


class ResearchNote(TimeStampedModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="research_notes")
    title = models.CharField(max_length=160)
    content = models.TextField(blank=True)
    category = models.CharField(max_length=80, blank=True)
    source_url = models.URLField(max_length=500, blank=True)
    pinned = models.BooleanField(default=False)

    class Meta:
        ordering = ["-pinned", "-updated_at"]

    def __str__(self) -> str:
        return self.title


class WritingGoal(TimeStampedModel):
    project = models.OneToOneField(Project, on_delete=models.CASCADE, related_name="writing_goal")
    target_word_count = models.PositiveIntegerField(default=50000)
    daily_target = models.PositiveIntegerField(default=1000)
    deadline = models.DateField(blank=True, null=True)

    def __str__(self) -> str:
        return f"Goal for {self.project.title}"


class FrontBackMatter(TimeStampedModel):
    SECTION_CHOICES = [
        ("dedication", "Dedication"),
        ("preface", "Preface"),
        ("foreword", "Foreword"),
        ("prologue", "Prologue"),
        ("epilogue", "Epilogue"),
        ("afterword", "Afterword"),
        ("appendix", "Appendix"),
        ("acknowledgments", "Acknowledgments"),
        ("author_note", "Author's Note"),
    ]

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="front_back_matter")
    section_type = models.CharField(max_length=30, choices=SECTION_CHOICES)
    title = models.CharField(max_length=160)
    content = models.TextField(blank=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "created_at"]

    def __str__(self) -> str:
        return f"{self.title} ({self.get_section_type_display()})"


class MapNode(TimeStampedModel):
    """A named node on the project mind-map canvas."""

    KIND_CHOICES = [
        ("character", "Character"),
        ("place", "Place"),
        ("chapter", "Chapter"),
        ("scene", "Scene"),
        ("theme", "Theme"),
        ("idea", "Idea"),
        ("research", "Research"),
        ("custom", "Custom"),
    ]

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="map_nodes")
    name = models.CharField(max_length=140)
    description = models.TextField(blank=True)
    position_x = models.FloatField(default=0)
    position_y = models.FloatField(default=0)
    kind = models.CharField(max_length=30, choices=KIND_CHOICES, default="custom")
    color = models.CharField(max_length=20, default="#c49a6c")
    source_type = models.CharField(max_length=30, blank=True)
    source_id = models.PositiveIntegerField(blank=True, null=True)

    class Meta:
        ordering = ["name"]
        unique_together = [["project", "name"]]

    def __str__(self) -> str:
        return self.name


class Connection(TimeStampedModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="connections")
    from_node = models.ForeignKey(
        MapNode,
        on_delete=models.CASCADE,
        related_name="outgoing_connections",
        blank=True,
        null=True,
    )
    to_node = models.ForeignKey(
        MapNode,
        on_delete=models.CASCADE,
        related_name="incoming_connections",
        blank=True,
        null=True,
    )
    from_entity = models.CharField(max_length=140)
    to_entity = models.CharField(max_length=140)
    relationship = models.CharField(max_length=200, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["from_entity", "to_entity"]

    def __str__(self) -> str:
        return f"{self.from_entity} → {self.to_entity}: {self.relationship}"

    def save(self, *args, **kwargs):
        if self.from_node:
            self.from_entity = self.from_node.name
        if self.to_node:
            self.to_entity = self.to_node.name
        super().save(*args, **kwargs)


class CoverDesign(TimeStampedModel):
    """Stores the cover designer state for a project."""

    EDITOR_MODE_CHOICES = [
        ("generated", "Generated"),
        ("upload", "Upload"),
    ]

    project = models.OneToOneField(Project, on_delete=models.CASCADE, related_name="cover_design")
    cover_image = models.ImageField(upload_to="covers/", blank=True, null=True)
    custom_cover = models.ImageField(upload_to="covers/custom/", blank=True, null=True)
    # "artwork" = image as background with text overlaid; "full" = image fills entire cover
    display_mode = models.CharField(max_length=20, default="artwork")
    editor_mode = models.CharField(max_length=20, choices=EDITOR_MODE_CHOICES, default="generated")
    template_id = models.CharField(max_length=60, blank=True, default="")

    # Background
    bg_color = models.CharField(max_length=20, default="#1a1a2e")

    # Typography - main title
    title_text = models.CharField(max_length=300, blank=True)
    title_font = models.CharField(max_length=100, default="Playfair Display, Georgia, serif")
    title_size = models.PositiveSmallIntegerField(default=48)
    title_color = models.CharField(max_length=20, default="#ffffff")

    # Subtitle / series tag
    subtitle_text = models.CharField(max_length=300, blank=True)
    subtitle_font = models.CharField(max_length=100, default="Arial, sans-serif")
    subtitle_size = models.PositiveSmallIntegerField(default=14)
    subtitle_color = models.CharField(max_length=20, default="#ec5b13")

    # Author
    author_text = models.CharField(max_length=200, blank=True)
    author_font = models.CharField(max_length=100, default="Arial, sans-serif")
    author_size = models.PositiveSmallIntegerField(default=16)
    author_color = models.CharField(max_length=20, default="#ffffff")

    # Layers ordering (JSON list of layer descriptors)
    layers = models.JSONField(default=list, blank=True)
    composition = models.JSONField(default=dict, blank=True)
    rendered_cover = models.ImageField(upload_to="covers/rendered/", blank=True, null=True)

    def __str__(self) -> str:
        return f"Cover: {self.project.title}"
