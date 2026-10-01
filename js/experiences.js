/* ==========================================================================
   LIST OF EXPERIENCES — the only file to edit to add a new one.

   To add an experience:
     1. Copy the folder  experiences/panel-zone/  to  experiences/<new-name>/
        and replace its photos/ and its TOUR block (see index.html there).
     2. Add one object below.

     title        name shown on the card
     category     small red label above the title (optional)
     description  one or two sentences
     image        preview picture, path relative to this site's root.
                  If the file is missing, a grey "Preview image" box is shown.
     url          page of the experience, relative to the site's root.
                  Always end with /index.html (a bare folder does not open
                  when the site is used straight from a folder).
                  Use null for "coming soon" (the card is then not clickable).
   ========================================================================== */
var EXPERIENCES = [
  {
    title: "Panel zone test — 360° tour",
    category: "Virtual visit",
    description: "Walk around the test setup in 360°: actuators, connections, specimen, instrumentation and operator desk.",
    image: "assets/images/preview-panel-zone.jpg",
    url: "experiences/panel-zone/index.html"
  },
  {
    title: "Experience 02",
    category: "Category",
    description: "Short description",
    image: "assets/images/preview-02.jpg",
    url: null
  },
  {
    title: "Experience 03",
    category: "Category",
    description: "Short description",
    image: "assets/images/preview-03.jpg",
    url: null
  }
];
