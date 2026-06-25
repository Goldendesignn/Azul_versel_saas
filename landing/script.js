var menuButton = document.querySelector(".menu-btn");
var header = document.querySelector(".site-header");

if (menuButton && header) {
  menuButton.addEventListener("click", function() {
    var open = header.classList.toggle("menu-open");
    menuButton.setAttribute("aria-expanded", String(open));
  });

  header.querySelectorAll("a").forEach(function(link) {
    link.addEventListener("click", function() {
      header.classList.remove("menu-open");
      menuButton.setAttribute("aria-expanded", "false");
    });
  });
}
