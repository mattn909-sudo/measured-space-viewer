(() => {
  if (window.__measuredSpaceViewerStyleCustomizations) {
    return;
  }
  window.__measuredSpaceViewerStyleCustomizations = true;

  const compactIcon = `
    <svg class="ms-map-control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polyline points="4 14 10 14 10 20"></polyline>
      <polyline points="20 10 14 10 14 4"></polyline>
      <line x1="14" y1="10" x2="21" y2="3"></line>
      <line x1="3" y1="21" x2="10" y2="14"></line>
    </svg>`;

  const controlLabels = {
    floorplanwindow__close: {
      ariaLabel: "Compact map",
      icon: compactIcon,
      iconOnly: true,
      label: "Compact",
    },
    floorplanwindow__maximize: { label: "Expand" },
    floorplanwindow__minimize: { label: "Hide" },
  };

  const setMapButtonLabel = (button, config) => {
    if (!button || button.dataset.measuredSpaceLabel === config.label) {
      return;
    }

    button.dataset.measuredSpaceLabel = config.label;
    button.classList.toggle("ms-map-control-icon-only", Boolean(config.iconOnly));
    button.setAttribute("aria-label", config.ariaLabel || `${config.label} map`);
    button.setAttribute("title", config.ariaLabel || `${config.label} map`);

    let iconNode = button.querySelector(".ms-map-control-icon-wrap");
    if (config.icon) {
      if (!iconNode) {
        iconNode = document.createElement("span");
        iconNode.className = "ms-map-control-icon-wrap";
        button.appendChild(iconNode);
      }
      iconNode.innerHTML = config.icon;
    } else if (iconNode) {
      iconNode.remove();
    }

    let labelNode = button.querySelector(".ms-map-control-label");
    if (!labelNode) {
      labelNode = document.createElement("span");
      labelNode.className = "ms-map-control-label";
      button.appendChild(labelNode);
    }
    labelNode.textContent = config.label;
  };

  const applyViewerState = () => {
    document.querySelectorAll(".measured-space-viewer").forEach((viewer) => {
      const hasVisibleProfile = Boolean(viewer.querySelector(".banner-profile img, .banner-profile-image"));
      viewer.classList.toggle("ms-no-profile", !hasVisibleProfile);
    });

    Object.entries(controlLabels).forEach(([id, config]) => {
      setMapButtonLabel(document.getElementById(id), config);
    });
  };

  applyViewerState();

  new MutationObserver(applyViewerState).observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
  });
})();
