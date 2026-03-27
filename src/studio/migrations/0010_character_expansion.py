from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("studio", "0009_profile_ui_preferences"),
    ]

    operations = [
        migrations.AddField(model_name="character", name="avatar", field=models.ImageField(blank=True, null=True, upload_to="character_avatars/")),
        migrations.AddField(model_name="character", name="first_name", field=models.CharField(blank=True, max_length=80)),
        migrations.AddField(model_name="character", name="last_name", field=models.CharField(blank=True, max_length=80)),
        migrations.AddField(model_name="character", name="nickname", field=models.CharField(blank=True, max_length=120)),
        migrations.AddField(model_name="character", name="pronouns", field=models.CharField(blank=True, max_length=80)),
        migrations.AddField(model_name="character", name="sex_or_gender", field=models.CharField(blank=True, max_length=80)),
        migrations.AddField(model_name="character", name="species", field=models.CharField(blank=True, max_length=120)),
        migrations.AddField(model_name="character", name="age", field=models.PositiveSmallIntegerField(blank=True, null=True)),
        migrations.AddField(model_name="character", name="birth_date", field=models.DateField(blank=True, null=True)),
        migrations.AddField(model_name="character", name="birth_place", field=models.CharField(blank=True, max_length=160)),
        migrations.AddField(model_name="character", name="residence", field=models.CharField(blank=True, max_length=160)),
        migrations.AddField(model_name="character", name="occupation", field=models.CharField(blank=True, max_length=160)),
        migrations.AddField(model_name="character", name="personality", field=models.TextField(blank=True)),
        migrations.AddField(model_name="character", name="backstory", field=models.TextField(blank=True)),
        migrations.AddField(model_name="character", name="evolution", field=models.TextField(blank=True)),
        migrations.AddField(model_name="character", name="inventory", field=models.TextField(blank=True)),
        migrations.AddField(model_name="character", name="possessions", field=models.TextField(blank=True)),
        migrations.AddField(model_name="character", name="extras", field=models.TextField(blank=True)),
        migrations.AddField(
            model_name="character",
            name="star_rating",
            field=models.PositiveSmallIntegerField(default=3),
        ),
    ]
