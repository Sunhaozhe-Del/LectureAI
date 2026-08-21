/* LectureAI Auth v2
   Works with the existing index.html auth modal.
   Adds: login, signup, forgot password, password recovery,
   session-aware CTA, and safe profile loading.
*/
(function () {
  const url = window.LECTUREAI_SUPABASE_URL;
  const key = window.LECTUREAI_SUPABASE_KEY;

  if (!window.supabase || !url || !key) {
    window.lectureAIAuthReady = false;
    return;
  }

  const client = window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  window.lectureAISupabase = client;
  window.lectureAIAuthReady = true;

  let authMode = "signup";

  function el(id) { return document.getElementById(id); }
  function message(text, good = false) {
    const node = el("authMessage");
    if (!node) return;
    node.textContent = text || "";
    node.style.color = good ? "#18794e" : "#c62828";
  }

  window.openAuth = function (type) {
    authMode = type === "login" ? "login" : "signup";
    const modal = el("authModal");
    if (!modal) return;

    el("modalTitle").textContent =
      authMode === "login" ? "Welcome back" : "Create your account";
    el("modalText").textContent =
      authMode === "login"
        ? "Log in to continue using LectureAI."
        : "Start using LectureAI today.";

    const name = el("authName");
    if (name) name.style.display = authMode === "login" ? "none" : "block";

    el("authPassword").setAttribute(
      "autocomplete",
      authMode === "login" ? "current-password" : "new-password"
    );
    el("authSubmit").textContent =
      authMode === "login" ? "Log in" : "Create account";
    el("authSwitchText").textContent =
      authMode === "login" ? "Don't have an account?" : "Already have an account?";
    el("authSwitch").textContent =
      authMode === "login" ? "Create one" : "Log in";

    message("");
    modal.classList.add("active");
  };

  window.toggleAuthMode = function () {
    window.openAuth(authMode === "login" ? "signup" : "login");
  };

  window.forgotPassword = async function () {
    const email = (el("authEmail")?.value || "").trim();
    if (!email || !email.includes("@")) {
      message("Enter your email address first.");
      return;
    }

    try {
      const redirectTo = `${window.location.origin}/reset-password.html`;
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      message("If an account exists for this email, a password-reset email has been sent.", true);
    } catch (error) {
      message(error.message || "Unable to send the reset email.");
    }
  };

  function addForgotPasswordLink() {
    if (!el("authPassword") || document.getElementById("forgotPasswordLink")) return;
    const link = document.createElement("button");
    link.id = "forgotPasswordLink";
    link.type = "button";
    link.textContent = "Forgot password?";
    link.style.cssText =
      "display:none;border:0;background:none;color:#0071e3;font-size:13px;padding:8px 0;cursor:pointer;";
    link.onclick = window.forgotPassword;
    el("authPassword").insertAdjacentElement("afterend", link);
  }

  window.submitAuth = async function () {
    const button = el("authSubmit");
    const name = (el("authName")?.value || "").trim();
    const email = (el("authEmail")?.value || "").trim();
    const password = el("authPassword")?.value || "";

    if (!email || !email.includes("@")) {
      message("Please enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      message("Password must be at least 6 characters.");
      return;
    }

    button.disabled = true;
    button.style.opacity = "0.6";
    message(authMode === "login" ? "Logging in…" : "Creating your account…", true);

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
            emailRedirectTo: `${window.location.origin}/dashboard.html`
          }
        });
      }

      if (result.error) throw result.error;

      if (authMode === "signup") {
        if (result.data.session) {
          window.location.href = "/dashboard.html";
        } else {
          message(
            "Account created. Check your email and click the verification link to continue.",
            true
          );
        }
      } else {
        window.location.href = "/dashboard.html";
      }
    } catch (error) {
      message(error.message || "Authentication failed.");
    } finally {
      button.disabled = false;
      button.style.opacity = "1";
    }
  };

  window.closeAuth = function () {
    const modal = el("authModal");
    if (modal) modal.classList.remove("active");
  };

  addForgotPasswordLink();

  // Show the forgot-password link only in login mode.
  const originalOpenAuth = window.openAuth;
  window.openAuth = function (type) {
    originalOpenAuth(type);
    const link = el("forgotPasswordLink");
    if (link) link.style.display = type === "login" ? "block" : "none";
  };

  client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") return;
    if (session && window.location.pathname === "/") {
      document.querySelectorAll('[onclick*="openAuth(\'login\')"]').forEach((node) => {
        node.textContent = "Dashboard";
        node.onclick = () => { window.location.href = "/dashboard.html"; };
      });
    }
  });
})();
