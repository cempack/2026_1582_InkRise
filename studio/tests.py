import json
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from PIL import Image

from . import cover_renderer
from .models import Chapter, ChapterNote, ChapterRevision, ChapterSummary, Character, CharacterClass, Connection, CoverDesign, MapNode, Project, ProjectDictionaryEntry, count_words


User = get_user_model()
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\nIDATx\x9cc`\x00\x00\x00\x02"
    b"\x00\x01\xe2!\xbc3\x00\x00\x00\x00IEND\xaeB`\x82"
)


class InkRiseFlowTests(TestCase):
    def setUp(self):
        self.password = "StoryPass123!"

    def create_user(self, username="writer") -> User:
        return User.objects.create_user(
            username=username,
            email=f"{username}@example.com",
            password=self.password,
        )

    def login(self, username="writer") -> User:
        user = self.create_user(username=username)
        self.client.login(username=username, password=self.password)
        return user

    def json_post(self, url, payload, method="post"):
        return getattr(self.client, method)(
            url,
            data=json.dumps(payload),
            content_type="application/json",
        )

    def test_spa_shell_and_session_endpoint_load(self):
        shell_response = self.client.get(reverse("login"))
        session_response = self.client.get(reverse("api_session"))
        self.assertContains(shell_response, 'id="root"')
        self.assertEqual(session_response.json()["authenticated"], False)

    def test_register_api_creates_profile_and_session(self):
        response = self.json_post(
            reverse("api_register"),
            {
                "username": "novelist",
                "first_name": "Nina",
                "email": "nina@example.com",
                "password1": self.password,
                "password2": self.password,
            },
        )
        self.assertEqual(response.status_code, 201)
        user = User.objects.get(username="novelist")
        self.assertEqual(user.profile.pen_name, "")
        self.assertEqual(self.client.get(reverse("api_session")).json()["authenticated"], True)

    def test_project_create_bootstraps_first_chapter(self):
        user = self.login()
        user.profile.default_font_family = "sans"
        user.profile.default_font_size = 20
        user.profile.save()

        response = self.json_post(
            reverse("api_projects"),
            {
                "title": "Moon Archive",
                "logline": "A smuggler returns to a haunted library on the moon.",
                "description": "Long-form science fantasy manuscript.",
                "genre": "Science fantasy",
                "accent_color": "#5b56ff",
            },
        )

        project = Project.objects.get(title="Moon Archive")
        chapter = project.chapters.get()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["redirect"], f"/projects/{project.slug}/workspace/{chapter.pk}/")
        self.assertEqual(chapter.title, "Chapter 1")
        self.assertEqual(project.manuscript_font_family, "sans")
        self.assertEqual(project.manuscript_font_size, 20)

    def test_autosave_updates_counts_and_creates_revision(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Ink Sea")
        chapter = Chapter.objects.create(project=project, title="Arrival")
        ChapterSummary.objects.create(chapter=chapter)

        response = self.json_post(
            reverse("api_autosave", kwargs={"project_slug": project.slug, "chapter_id": chapter.pk}),
            {
                "title": "Arrival",
                "content": "<p>The harbor slept beneath silver rain.</p><p>Every lantern watched.</p>",
            },
        )

        self.assertEqual(response.status_code, 200)
        chapter.refresh_from_db()
        self.assertGreater(chapter.word_count, 0)
        self.assertEqual(ChapterRevision.objects.filter(chapter=chapter).count(), 1)
        payload = response.json()
        self.assertEqual(payload["status"], "saved")
        self.assertEqual(payload["project"]["stats"]["totalWordCount"], chapter.word_count)

    def test_workspace_tools_persist_dictionary_notes_and_characters(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Garden of Salt")
        chapter = Chapter.objects.create(project=project, title="Opening")
        ChapterSummary.objects.create(chapter=chapter)

        self.json_post(
            reverse("api_dictionary", kwargs={"project_slug": project.slug}),
            {
                "term": "Starwell",
                "definition": "A vertical harbor carved into the crater wall.",
                "usageNotes": "Always capitalized.",
            },
        )
        self.json_post(
            reverse("api_notes", kwargs={"project_slug": project.slug, "chapter_id": chapter.pk}),
            {
                "title": "Continuity",
                "body": "Lanterns should already be lit before the dock scene.",
                "pinned": True,
            },
        )
        self.json_post(
            reverse("api_character_classes", kwargs={"project_slug": project.slug}),
            {
                "name": "Crew",
                "description": "Ship and harbor workers",
            },
        )
        character_class = CharacterClass.objects.get(project=project, name="Crew")
        self.json_post(
            reverse("api_characters", kwargs={"project_slug": project.slug}),
            {
                "name": "Mira Vale",
                "role": "Captain",
                "summary": "A stubborn courier captain.",
                "appearance": "",
                "goals": "Leave the harbor before dawn.",
                "conflicts": "Debt and a damaged engine.",
                "notes": "",
                "classIds": [character_class.pk],
            },
        )

        self.assertTrue(ProjectDictionaryEntry.objects.filter(project=project, term="Starwell").exists())
        self.assertTrue(ChapterNote.objects.filter(chapter=chapter, title="Continuity").exists())
        self.assertTrue(Character.objects.filter(project=project, name="Mira Vale").exists())

    def test_language_tools_endpoints_return_results(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Winter Glass")
        chapter = Chapter.objects.create(project=project, title="Cold Open")
        ChapterSummary.objects.create(chapter=chapter)

        thesaurus_response = self.client.get(
            reverse("api_thesaurus", kwargs={"project_slug": project.slug}),
            {"term": "calm"},
        )
        correct_response = self.json_post(
            reverse("api_correct_text", kwargs={"project_slug": project.slug}),
            {"text": "she dont know where the maps is going or why there disappearing so quick"},
        )

        self.assertEqual(thesaurus_response.status_code, 200)
        self.assertIn("matches", thesaurus_response.json())
        self.assertEqual(correct_response.status_code, 200)
        self.assertEqual(
            correct_response.json()["corrected"],
            "She doesn't know where the maps are going or why they're disappearing so quickly.",
        )

    def test_mind_map_node_rename_updates_connections(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Atlas")
        from_node = MapNode.objects.create(project=project, name="Mira")
        MapNode.objects.create(project=project, name="Port")
        Connection.objects.create(project=project, from_entity="Mira", to_entity="Port", relationship="visits")

        response = self.json_post(
            reverse("api_map_node_detail", kwargs={"project_slug": project.slug, "node_id": from_node.pk}),
            {"name": "Mira Vale"},
            method="patch",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(Connection.objects.filter(project=project, from_entity="Mira Vale", to_entity="Port").exists())
        self.assertFalse(Connection.objects.filter(project=project, from_entity="Mira", to_entity="Port").exists())

    def test_connections_require_existing_map_nodes(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Atlas 2")
        MapNode.objects.create(project=project, name="Mira")

        response = self.json_post(
            reverse("api_connections", kwargs={"project_slug": project.slug}),
            {"fromEntity": "Mira", "toEntity": "Ghost", "relationship": "knows"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(Connection.objects.filter(project=project).count(), 0)

    def test_connections_api_persists_node_ids(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Atlas 3")
        from_node = MapNode.objects.create(project=project, name="Mira")
        to_node = MapNode.objects.create(project=project, name="Port")

        response = self.json_post(
            reverse("api_connections", kwargs={"project_slug": project.slug}),
            {"fromNodeId": from_node.pk, "toNodeId": to_node.pk, "label": "visits"},
        )

        self.assertEqual(response.status_code, 201)
        connection = Connection.objects.get(project=project)
        self.assertEqual(connection.from_node_id, from_node.pk)
        self.assertEqual(connection.to_node_id, to_node.pk)
        self.assertEqual(response.json()["connection"]["label"], "visits")

    def test_map_node_create_persists_kind_and_color(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Atlas 4")

        response = self.json_post(
            reverse("api_map_nodes_create", kwargs={"project_slug": project.slug}),
            {
                "name": "Piste visuelle",
                "description": "Une idee forte pour la couverture.",
                "kind": "idea",
                "color": "#F472B6",
                "positionX": 320,
                "positionY": 180,
            },
        )

        self.assertEqual(response.status_code, 201)
        node = MapNode.objects.get(project=project, name="Piste visuelle")
        self.assertEqual(node.kind, "idea")
        self.assertEqual(node.color, "#f472b6")
        self.assertEqual(response.json()["node"]["kind"], "idea")
        self.assertEqual(response.json()["node"]["color"], "#f472b6")

    def test_map_node_patch_updates_kind_and_color(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Atlas 5")
        node = MapNode.objects.create(project=project, name="Libre")

        response = self.json_post(
            reverse("api_map_node_detail", kwargs={"project_slug": project.slug, "node_id": node.pk}),
            {"kind": "theme", "color": "#A78BFA"},
            method="patch",
        )

        self.assertEqual(response.status_code, 200)
        node.refresh_from_db()
        self.assertEqual(node.kind, "theme")
        self.assertEqual(node.color, "#a78bfa")

    def test_map_import_chapters_uses_summary_text(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Import Atlas")
        chapter = Chapter.objects.create(
            project=project,
            title="Arrival",
            content="<p>The harbor slept beneath silver rain.</p>",
        )
        ChapterSummary.objects.create(chapter=chapter, summary="A stormy arrival in the harbor.")

        response = self.json_post(
            reverse("api_map_import", kwargs={"project_slug": project.slug}),
            {"sourceType": "chapters"},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["nodes"][0]["description"], "A stormy arrival in the harbor.")

    def test_map_import_assigns_kind_and_color_from_source(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Import Colors")
        Character.objects.create(project=project, name="Mira", summary="Capitaine obstinee.")

        response = self.json_post(
            reverse("api_map_import", kwargs={"project_slug": project.slug}),
            {"sourceType": "characters"},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["nodes"][0]["kind"], "character")
        self.assertEqual(response.json()["nodes"][0]["color"], "#6ba8d4")

    def test_word_count_handles_dashes_and_apostrophes(self):
        self.assertEqual(count_words("state-of-the-art"), 1)
        self.assertEqual(count_words("foo—bar"), 2)
        self.assertEqual(count_words("word--word"), 2)
        self.assertEqual(count_words("l'amour du texte"), 3)

    def test_cover_rejects_invalid_layers_payload(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Cover Lab")

        response = self.json_post(
            reverse("api_cover_design", kwargs={"project_slug": project.slug}),
            {"layers": {"not": "a list"}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())

    def test_cover_upload_sets_full_display_mode(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Cover Upload")

        image = SimpleUploadedFile(
            "cover.png",
            TINY_PNG,
            content_type="image/png",
        )
        response = self.client.post(
            reverse("api_cover_upload", kwargs={"project_slug": project.slug}),
            {"image": image, "display_mode": "full"},
        )

        self.assertEqual(response.status_code, 200)
        cover = CoverDesign.objects.get(project=project)
        self.assertEqual(cover.display_mode, "full")
        self.assertTrue(cover.rendered_cover)

    def test_cover_get_generates_rendered_cover_if_missing(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Cover Refresh")
        cover = CoverDesign.objects.create(project=project, title_text="Cover Refresh")

        response = self.client.get(
            reverse("api_cover_design", kwargs={"project_slug": project.slug}),
        )

        self.assertEqual(response.status_code, 200)
        cover.refresh_from_db()
        self.assertTrue(cover.rendered_cover)
        self.assertIn("?v=", response.json()["cover"]["renderedCoverUrl"])

    def test_cover_serializes_editor_metadata(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Metadata Cover")
        CoverDesign.objects.create(
            project=project,
            title_text="Metadata Cover",
            editor_mode="generated",
            template_id="ember-line",
        )

        response = self.client.get(
            reverse("api_cover_design", kwargs={"project_slug": project.slug}),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["cover"]["editorMode"], "generated")
        self.assertEqual(response.json()["cover"]["templateId"], "ember-line")

    def test_cover_render_contains_text_pixels(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Visible Cover")
        cover = CoverDesign.objects.create(
            project=project,
            bg_color="#111111",
            title_text="Visible Cover",
            author_text="A. Writer",
        )

        self.client.get(reverse("api_cover_design", kwargs={"project_slug": project.slug}))
        cover.refresh_from_db()
        cover.rendered_cover.open("rb")
        with Image.open(cover.rendered_cover) as rendered:
            colors = rendered.convert("RGB").getcolors(maxcolors=1000000)
        cover.rendered_cover.close()

        self.assertIsNotNone(colors)
        self.assertGreater(len(colors), 1)

    def test_export_html_generates_rendered_cover_when_missing(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Export Cover")
        CoverDesign.objects.create(project=project, title_text="Export Cover", author_text="A. Writer")

        response = self.client.get(
            reverse("api_export", kwargs={"project_slug": project.slug}),
            {"format": "html"},
        )

        self.assertEqual(response.status_code, 200)
        project.cover_design.refresh_from_db()
        self.assertTrue(project.cover_design.rendered_cover)
        self.assertIn(project.cover_design.rendered_cover.url, response.json()["content"])

    def test_custom_cover_upload_switches_to_upload_mode(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Custom Upload")

        image = SimpleUploadedFile(
            "custom.png",
            TINY_PNG,
            content_type="image/png",
        )
        response = self.client.post(
            reverse("api_cover_upload", kwargs={"project_slug": project.slug}),
            {"image": image, "target": "custom"},
        )

        self.assertEqual(response.status_code, 200)
        cover = CoverDesign.objects.get(project=project)
        self.assertEqual(cover.editor_mode, "upload")
        self.assertTrue(cover.custom_cover)
        self.assertFalse(bool(cover.rendered_cover))
        self.assertEqual(response.json()["cover"]["editorMode"], "upload")
        self.assertIn(cover.custom_cover.url, response.json()["cover"]["customCoverUrl"])

    def test_cover_post_persists_background_crop_metadata(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Cover Crop")
        cover = CoverDesign.objects.create(project=project, title_text="Cover Crop")

        response = self.json_post(
            reverse("api_cover_design", kwargs={"project_slug": project.slug}),
            {
                "composition": {
                    "version": 2,
                    "layers": [
                        {
                            "id": "bg",
                            "type": "background",
                            "imageUrl": "/media/covers/example.png",
                            "cropX": 12.5,
                            "cropY": 8.0,
                            "cropWidth": 72.0,
                            "cropHeight": 64.0,
                            "rotation": 15,
                            "flipX": -1,
                            "flipY": 1,
                        }
                    ],
                }
            },
        )

        self.assertEqual(response.status_code, 200)
        cover.refresh_from_db()
        background_layer = cover.composition["layers"][0]
        self.assertEqual(background_layer["cropX"], 12.5)
        self.assertEqual(background_layer["cropY"], 8.0)
        self.assertEqual(background_layer["cropWidth"], 72.0)
        self.assertEqual(background_layer["cropHeight"], 64.0)
        self.assertEqual(background_layer["rotation"], 15.0)
        self.assertEqual(background_layer["flipX"], -1)
        self.assertEqual(background_layer["flipY"], 1)

    def test_export_html_preview_mode_includes_screen_preview_css(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Preview Book")
        CoverDesign.objects.create(project=project, title_text="Preview Book", author_text="A. Writer")

        response = self.client.get(
            reverse("api_export", kwargs={"project_slug": project.slug}),
            {"format": "html", "preview": "1"},
        )

        self.assertEqual(response.status_code, 200)
        project.cover_design.refresh_from_db()
        content = response.json()["content"]
        self.assertIn("@media screen", content)
        self.assertIn("width: min(100%, 7.2in);", content)
        self.assertIn(project.cover_design.rendered_cover.url, content)

    def test_export_html_preview_uses_custom_cover_in_upload_mode(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Upload Preview")
        cover = CoverDesign.objects.create(
            project=project,
            title_text="Upload Preview",
            author_text="A. Writer",
            editor_mode="upload",
            custom_cover=SimpleUploadedFile("cover.png", TINY_PNG, content_type="image/png"),
        )

        response = self.client.get(
            reverse("api_export", kwargs={"project_slug": project.slug}),
            {"format": "html", "preview": "1"},
        )

        self.assertEqual(response.status_code, 200)
        cover.refresh_from_db()
        content = response.json()["content"]
        self.assertIn(cover.custom_cover.url, content)
        self.assertNotIn('<div class="cover-overlay">', content)

    def test_export_html_falls_back_to_text_cover_when_no_asset_exists(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Fallback Preview")
        CoverDesign.objects.create(
            project=project,
            title_text="Fallback Preview",
            author_text="A. Writer",
            editor_mode="upload",
        )

        response = self.client.get(
            reverse("api_export", kwargs={"project_slug": project.slug}),
            {"format": "html"},
        )

        self.assertEqual(response.status_code, 200)
        content = response.json()["content"]
        self.assertIn("cover-title-text", content)
        self.assertIn("Fallback Preview", content)

    def test_export_html_without_preview_omits_screen_preview_css(self):
        user = self.login()
        project = Project.objects.create(user=user, title="Print Book")

        response = self.client.get(
            reverse("api_export", kwargs={"project_slug": project.slug}),
            {"format": "html"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("@media screen", response.json()["content"])

    def test_cover_font_fallback_preserves_requested_size(self):
        with mock.patch.object(cover_renderer, "_first_existing", return_value=None):
            font = cover_renderer._load_font("Missing Font, serif", 88, "700")
        self.assertEqual(getattr(font, "size", None), 88)
