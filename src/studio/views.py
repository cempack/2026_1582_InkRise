from django.contrib.admin.views.decorators import staff_member_required
from django.contrib.auth import get_user_model, logout
from django.http import HttpRequest, HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import redirect, render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from .models import Chapter, Character, Project


@ensure_csrf_cookie
def app_shell(request: HttpRequest, *args, **kwargs) -> HttpResponse:
    return render(
        request,
        "react_app.html",
        {
            "csrf_token_value": get_token(request),
            "initial_path": request.path,
        },
    )


@require_http_methods(["GET", "POST"])
def legacy_logout(request: HttpRequest) -> HttpResponse:
    logout(request)
    return redirect("/login/")


@staff_member_required
@require_http_methods(["GET"])
def staff_admin_hub(request: HttpRequest) -> HttpResponse:
    User = get_user_model()
    recent_users = User.objects.order_by("-date_joined")[:12]
    return render(
        request,
        "studio/staff_console.html",
        {
            "user_count": User.objects.count(),
            "project_count": Project.objects.count(),
            "chapter_count": Chapter.objects.count(),
            "character_count": Character.objects.count(),
            "recent_users": recent_users,
        },
    )
