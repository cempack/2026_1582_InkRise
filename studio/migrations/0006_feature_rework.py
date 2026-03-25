from django.db import migrations, models
import django.db.models.deletion


def migrate_connections_and_covers(apps, schema_editor):
    Connection = apps.get_model("studio", "Connection")
    CoverDesign = apps.get_model("studio", "CoverDesign")
    MapNode = apps.get_model("studio", "MapNode")

    for connection in Connection.objects.select_related("project").all():
        from_node = MapNode.objects.filter(project=connection.project, name=connection.from_entity).first()
        to_node = MapNode.objects.filter(project=connection.project, name=connection.to_entity).first()
        updates = []
        if from_node:
            connection.from_node_id = from_node.pk
            updates.append("from_node")
        if to_node:
            connection.to_node_id = to_node.pk
            updates.append("to_node")
        if updates:
            connection.save(update_fields=updates)

    for cover in CoverDesign.objects.select_related("project__user__profile").all():
        author = (
            cover.project.user.profile.pen_name
            or cover.project.user.get_full_name()
            or cover.project.user.username
        )
        bg_image = cover.cover_image.url if cover.cover_image else ""
        cover.composition = {
            "version": 2,
            "layers": [
                {
                    "id": "bg",
                    "type": "background",
                    "x": 0,
                    "y": 0,
                    "w": 100,
                    "h": 100,
                    "color": cover.bg_color or "#1a1a2e",
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
                    "text": cover.subtitle_text or "",
                    "x": 12,
                    "y": 12,
                    "w": 76,
                    "h": 8,
                    "fontFamily": cover.subtitle_font,
                    "fontSize": cover.subtitle_size,
                    "fontWeight": "500",
                    "color": cover.subtitle_color or cover.title_color or "#f7f1e8",
                    "align": "center",
                    "opacity": 1,
                    "visible": bool(cover.subtitle_text),
                    "zIndex": 10,
                },
                {
                    "id": "title",
                    "type": "text",
                    "role": "title",
                    "text": cover.title_text or cover.project.title,
                    "x": 10,
                    "y": 28,
                    "w": 80,
                    "h": 24,
                    "fontFamily": cover.title_font,
                    "fontSize": cover.title_size,
                    "fontWeight": "700",
                    "color": cover.title_color or "#f7f1e8",
                    "align": "center",
                    "opacity": 1,
                    "visible": True,
                    "zIndex": 20,
                },
                {
                    "id": "author",
                    "type": "text",
                    "role": "author",
                    "text": cover.author_text or author,
                    "x": 16,
                    "y": 84,
                    "w": 68,
                    "h": 8,
                    "fontFamily": cover.author_font,
                    "fontSize": cover.author_size,
                    "fontWeight": "600",
                    "color": cover.author_color or "#f7f1e8",
                    "align": "center",
                    "opacity": 1,
                    "visible": True,
                    "zIndex": 30,
                },
            ],
        }
        cover.save(update_fields=["composition"])


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0005_add_mapnode"),
    ]

    operations = [
        migrations.AddField(
            model_name="connection",
            name="from_node",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="outgoing_connections", to="studio.mapnode"),
        ),
        migrations.AddField(
            model_name="connection",
            name="to_node",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="incoming_connections", to="studio.mapnode"),
        ),
        migrations.AddField(
            model_name="coverdesign",
            name="composition",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="coverdesign",
            name="rendered_cover",
            field=models.ImageField(blank=True, null=True, upload_to="covers/rendered/"),
        ),
        migrations.AddField(
            model_name="mapnode",
            name="source_id",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="mapnode",
            name="source_type",
            field=models.CharField(blank=True, max_length=30),
        ),
        migrations.RunPython(migrate_connections_and_covers, migrations.RunPython.noop),
    ]
