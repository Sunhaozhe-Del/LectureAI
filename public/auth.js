(function () {
  const cfg = window.LECTUREAI_SUPABASE_URL;
  const key = window.LECTUREAI_SUPABASE_KEY;

  if (!window.supabase || !cfg || !key ||
      cfg.startsWith("PASTE_") || key.startsWith("PASTE_")) {
    window.lectureAIAuthReady = false;
    return;
  }

  const client = window.supabase.createClient(cfg, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  window.lectureAISupabase = client;
  window.lectureAIAuthReady = true;

  let authMode = "signup";

  window.openAuth = function (type) {
    authMode = type === "login" ? "login" : "signup";
    const modal = document.getElementById("authModal");
    if (!modal) return;

    document.getElementById("modalTitle").textContent =
      authMode === "login" ? "Welcome back" : "Create your account";

    document.getElementById("modalText").textContent =
      authMode === "login"
        ? "Log in to continue using LectureAI."
        : "Start using LectureAI today.";

    document.getElementById("authName").style.display =
      authMode === "login" ? "none" : "block";

    document.getElementById("authPassword").setAttribute(
      "autocomplete",
      authMode === "login" ? "current-password" : "new-password"
    );

    document.getElementById("authSubmit").textContent =
      authMode === "login" ? "Log in" : "Create account";

    document.getElementById("authSwitchText").textContent =
      authMode === "login" ? "Don't have an account?" : "Already have an account?";

    document.getElementById("authSwitch").textContent =
      authMode === "login" ? "Create one" : "Log in";

    document.getElementById("authMessage").textContent = "";
    modal.classList.add("active");
  };

  window.toggleAuthMode = function () {
    window.openAuth(authMode === "login" ? "signup" : "login");
  };

  window.submitAuth = async function () {
    const message = document.getElementById("authMessage");
    const button = document.getElementById("authSubmit");
    const name = document.getElementById("authName").value.trim();
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;

    message.style.color = "#c62828";

    if (!email || !email.includes("@")) {
      message.textContent = "Please enter a valid email address.";
      return;
    }

    if (password.length < 6) {
      message.textContent = "Password must be at least 6 characters.";
      return;
    }

    button.disabled = true;
    button.style.opacity = "0.6";
    message.style.color = "#6e6e73";
    message.textContent = authMode === "login" ? "Logging in…" : "Creating your account…";

    try {
      let result;

      if (authMode === "login") {
        result = await client.auth.signInWithPassword({ email, password });
      } else {
        result = await client.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name || null },
            emailRedirectTo: window.location.origin + "/dashboard.html"
          }
        });
      }

      if (result.error) throw result.error;

      if (authMode === "signup") {
        if (result.data.session) {
          window.location.href = "/dashboard.html";
        } else {
          message.style.color = "#18794e";
          message.textContent =
            "Account created. Check your email and click the verification link to continue.";
        }
      } else {
        window.location.href = "/dashboard.html";
      }
    } catch (error) {
      message.style.color = "#c62828";
      message.textContent = error.message || "Authentication failed.";
    } finally {
      button.disabled = false;
      button.style.opacity = "1";
    }
  };

  window.closeAuth = function () {
    const modal = document.getElementById("authModal");
    if (modal) modal.classList.remove("active");
  };

  // If the user is already signed in, turn the main CTA into a dashboard link.
  client.auth.getSession().then(({ data }) => {
    if (!data.session) return;
    document.querySelectorAll('[onclick*="openAuth(\'login\')"]').forEach((el) => {
      el.textContent = "Dashboard";
      el.onclick = () => { window.location.href = "/dashboard.html"; };
    });
  });
})();
