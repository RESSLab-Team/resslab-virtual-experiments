/* Shared page frame (EPFL logo bar, breadcrumb, footer) and the catalogue grid.
   <body data-root="../../" data-crumb="Title"> tells the script where the site
   root is and the current page name (omit data-crumb on the home page). */
(function () {
  "use strict";
  var root = document.body.getAttribute("data-root") || "";
  var crumb = document.body.getAttribute("data-crumb");
  var LAB = "Resilient Steel Structures Laboratory (RESSLab)";
  var LAB_URL = "https://www.epfl.ch/labs/resslab/";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var top = document.getElementById("site-top");
  if (top) {
    top.innerHTML =
      '<div class="site-header"><div class="container">' +
        '<a class="logo" href="https://www.epfl.ch/" aria-label="EPFL"><img src="' + root + 'assets/epfl-logo.svg" alt="EPFL"></a>' +
        // RESSLab logo: put the file at assets/resslab-logo.webp (the text shows until it exists)
        '<a class="lab-logo" href="' + root + 'index.html" aria-label="RESSLab">' +
          '<img src="' + root + 'assets/resslab-logo.webp" alt="RESSLab" onerror="this.replaceWith(document.createTextNode(\'RESSLab\'))"></a>' +
        '<a class="lab-title" href="' + root + 'index.html">Virtual experiments</a>' +
      '</div></div>' +
      '<nav class="crumbs" aria-label="Breadcrumb"><div class="container">' +
        '<a href="' + LAB_URL + '">' + LAB + '</a><span class="sep">›</span>' +
        (crumb ? '<a href="' + root + 'index.html">Virtual experiments</a><span class="sep">›</span>' + esc(crumb)
               : "Virtual experiments") +
      '</div></nav>';
  }

  var foot = document.getElementById("site-foot");
  if (foot) {
    foot.innerHTML = '<footer class="site-footer"><div class="container">' +
      '<span>' + LAB + ' — EPFL</span>' +
      '<a href="' + LAB_URL + '">www.epfl.ch/labs/resslab</a></div></footer>';
  }

  /* ---- catalogue grid (home page only) ---- */
  var grid = document.getElementById("experiences");
  if (grid && window.EXPERIENCES) {
    grid.innerHTML = EXPERIENCES.map(function (x) {
      var open = !!x.url;
      var inner =
        '<div class="thumb"><span>Preview image</span>' +
          (x.image ? '<img src="' + esc(x.image) + '" alt="" loading="lazy" onerror="this.remove()">' : "") + '</div>' +
        '<div class="body">' +
          (x.category ? '<p class="cat">' + esc(x.category) + '</p>' : "") +
          '<h2>' + esc(x.title) + '</h2>' +
          '<p class="desc">' + esc(x.description) + '</p>' +
          '<span class="go' + (open ? "" : " off") + '">' + (open ? "View →" : "Coming soon") + '</span>' +
        '</div>';
      return open
        ? '<a class="xcard" href="' + esc(x.url) + '">' + inner + '</a>'
        : '<div class="xcard soon">' + inner + '</div>';
    }).join("");
  }
})();
