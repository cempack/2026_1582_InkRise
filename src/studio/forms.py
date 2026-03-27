import re

from django import forms
from django.contrib.auth import get_user_model
from django.contrib.auth.forms import UserCreationForm

from .models import ChapterNote, Character, CharacterClass, Connection, FrontBackMatter, Place, Profile, Project, ProjectDictionaryEntry, ResearchNote, WritingGoal


User = get_user_model()


class StyledModelForm(forms.ModelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            css_class = field.widget.attrs.get("class", "")
            field.widget.attrs["class"] = f"{css_class} input".strip()


class RegisterForm(UserCreationForm):
    email = forms.EmailField()
    first_name = forms.CharField(max_length=120, required=False)

    class Meta:
        model = User
        fields = ("username", "first_name", "email", "password1", "password2")

    def save(self, commit=True):
        user = super().save(commit=False)
        user.email = self.cleaned_data["email"]
        user.first_name = self.cleaned_data.get("first_name", "")
        if commit:
            user.save()
        return user


_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


class ProfileForm(StyledModelForm):
    class Meta:
        model = Profile
        fields = (
            "pen_name",
            "bio",
            "avatar",
            "default_font_family",
            "default_font_size",
            "default_line_height",
            "default_content_width",
            "ui_theme",
            "ui_accent",
        )
        widgets = {
            "bio": forms.Textarea(attrs={"rows": 4}),
            "ui_accent": forms.TextInput(
                attrs={"placeholder": "#c49a6c", "class": "input", "maxLength": 7, "spellCheck": "false"}
            ),
        }

    def clean_ui_accent(self):
        raw = (self.cleaned_data.get("ui_accent") or "").strip()
        if not raw:
            return ""
        if not _HEX_COLOR.match(raw):
            raise forms.ValidationError("Utilisez un code couleur hexadécimal (#RRGGBB).")
        return raw


class ProjectForm(StyledModelForm):
    class Meta:
        model = Project
        fields = ("title", "logline", "description", "genre", "accent_color")
        widgets = {
            "description": forms.Textarea(attrs={"rows": 5}),
            "accent_color": forms.TextInput(attrs={"type": "color", "class": "color-input"}),
        }


class ProjectFormattingForm(StyledModelForm):
    class Meta:
        model = Project
        fields = (
            "manuscript_font_family",
            "manuscript_font_size",
            "manuscript_line_height",
            "manuscript_width",
        )


class DictionaryEntryForm(StyledModelForm):
    class Meta:
        model = ProjectDictionaryEntry
        fields = ("term", "definition", "usage_notes")
        widgets = {
            "definition": forms.Textarea(attrs={"rows": 3}),
        }


class ChapterNoteForm(StyledModelForm):
    class Meta:
        model = ChapterNote
        fields = ("title", "body", "pinned")
        widgets = {
            "body": forms.Textarea(attrs={"rows": 4}),
        }


class CharacterClassForm(StyledModelForm):
    class Meta:
        model = CharacterClass
        fields = ("name", "description")
        widgets = {
            "description": forms.Textarea(attrs={"rows": 3}),
        }


class CharacterForm(StyledModelForm):
    classes = forms.ModelMultipleChoiceField(
        queryset=CharacterClass.objects.none(),
        required=False,
        widget=forms.CheckboxSelectMultiple,
    )

    class Meta:
        model = Character
        fields = (
            "name",
            "role",
            "avatar",
            "first_name",
            "last_name",
            "nickname",
            "pronouns",
            "sex_or_gender",
            "species",
            "age",
            "birth_date",
            "birth_place",
            "residence",
            "occupation",
            "summary",
            "appearance",
            "personality",
            "backstory",
            "evolution",
            "goals",
            "conflicts",
            "inventory",
            "possessions",
            "extras",
            "notes",
            "star_rating",
            "classes",
        )
        widgets = {
            "summary": forms.Textarea(attrs={"rows": 3}),
            "appearance": forms.Textarea(attrs={"rows": 3}),
            "personality": forms.Textarea(attrs={"rows": 3}),
            "backstory": forms.Textarea(attrs={"rows": 3}),
            "evolution": forms.Textarea(attrs={"rows": 3}),
            "goals": forms.Textarea(attrs={"rows": 3}),
            "conflicts": forms.Textarea(attrs={"rows": 3}),
            "inventory": forms.Textarea(attrs={"rows": 2}),
            "possessions": forms.Textarea(attrs={"rows": 2}),
            "extras": forms.Textarea(attrs={"rows": 2}),
            "notes": forms.Textarea(attrs={"rows": 4}),
        }

    def __init__(self, *args, project=None, **kwargs):
        super().__init__(*args, **kwargs)
        if project is not None:
            self.fields["classes"].queryset = project.character_classes.all()

    def clean_star_rating(self):
        v = self.cleaned_data.get("star_rating") or 3
        return max(1, min(5, int(v)))


class PlaceForm(StyledModelForm):
    class Meta:
        model = Place
        fields = ("name", "description", "significance", "history", "geography", "culture", "notes")
        widgets = {
            "description": forms.Textarea(attrs={"rows": 3}),
            "significance": forms.Textarea(attrs={"rows": 2}),
            "history": forms.Textarea(attrs={"rows": 2}),
            "geography": forms.Textarea(attrs={"rows": 2}),
            "culture": forms.Textarea(attrs={"rows": 2}),
            "notes": forms.Textarea(attrs={"rows": 3}),
        }


class ResearchNoteForm(StyledModelForm):
    class Meta:
        model = ResearchNote
        fields = ("title", "content", "category", "source_url", "pinned")
        widgets = {
            "content": forms.Textarea(attrs={"rows": 6}),
        }


class WritingGoalForm(StyledModelForm):
    class Meta:
        model = WritingGoal
        fields = ("target_word_count", "daily_target", "deadline")
        widgets = {
            "deadline": forms.DateInput(attrs={"type": "date"}),
        }


class FrontBackMatterForm(StyledModelForm):
    class Meta:
        model = FrontBackMatter
        fields = ("section_type", "title", "content", "position")
        widgets = {
            "content": forms.Textarea(attrs={"rows": 8}),
        }


class ConnectionForm(StyledModelForm):
    relationship = forms.CharField(required=False, max_length=200)

    class Meta:
        model = Connection
        fields = ("from_entity", "to_entity", "relationship", "notes")
        widgets = {
            "notes": forms.Textarea(attrs={"rows": 2}),
        }
