from django.db import migrations, models


def populate_node_kind_and_color(apps, schema_editor):
    MapNode = apps.get_model("studio", "MapNode")
    for node in MapNode.objects.all():
        if node.source_type == "characters":
            node.kind = "character"
            node.color = "#6ba8d4"
        elif node.source_type == "places":
            node.kind = "place"
            node.color = "#6bc490"
        elif node.source_type == "chapters":
            node.kind = "chapter"
            node.color = "#c49a6c"
        else:
            node.kind = "custom"
            node.color = "#c49a6c"
        node.save(update_fields=["kind", "color"])


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0006_feature_rework"),
    ]

    operations = [
        migrations.AddField(
            model_name="mapnode",
            name="color",
            field=models.CharField(default="#c49a6c", max_length=20),
        ),
        migrations.AddField(
            model_name="mapnode",
            name="kind",
            field=models.CharField(
                choices=[
                    ("character", "Character"),
                    ("place", "Place"),
                    ("chapter", "Chapter"),
                    ("scene", "Scene"),
                    ("theme", "Theme"),
                    ("idea", "Idea"),
                    ("research", "Research"),
                    ("custom", "Custom"),
                ],
                default="custom",
                max_length=30,
            ),
        ),
        migrations.RunPython(populate_node_kind_and_color, migrations.RunPython.noop),
    ]
