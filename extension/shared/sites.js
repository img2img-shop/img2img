// Site rules: "Never Run On", "Automatic Only On" and a workflow chosen for a site. Each rule is a host, one per
// line, and a bare host covers its subdomains ("example.com" matches www.example.com). A * stands for any part of a
// host ("*.wikipedia.org", "shop.*"), and anything pasted in as a full address keeps only its host.
// Loaded by content.js, which applies the rules, the popup, which says when a site is off, and the settings page,
// which edits them. Nothing here reads storage: the caller passes what it read.
(() => {
  // One host a line, also accepting a comma-separated list, a pasted address or a trailing path
  function patterns(text) {
    if (Array.isArray(text)) {
      return text.flatMap(patterns);
    }
    return String(text || '')
      .split(/[\n,;]+/)
      .map(line => line
        .trim()
        .replace(/^[a-z]+:\/\//i, '') // https://example.com/page -> example.com/page
        .replace(/\/.*$/, '') // example.com/page -> example.com
        .replace(/^www\./i, '') // (a bare host covers its subdomains anyway, www. included)
        .replace(/:\d+$/, '') // example.com:8080 -> example.com
        .toLowerCase())
      .filter(Boolean);
  }

  function host(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (error) {
      return ''; // not a page with a host: an extension page, about:blank, a file
    }
  }

  // Whether one pattern covers a host
  function covers(pattern, hostname) {
    if (!pattern || !hostname) {
      return false;
    }
    if (pattern.includes('*')) {
      const parts = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return new RegExp(`^${parts.join('.*')}$`).test(hostname);
    }
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  }

  globalThis.img2imgSites = {
    patterns,
    host,
    covers,
    // Whether a list of patterns (as typed, or already split) covers a page's URL
    matches(list, url) {
      const hostname = host(url);
      return hostname ? patterns(list).some(pattern => covers(pattern, hostname)) : false;
    },
    // The workflow a site's rule chooses, from [{ site, workflow }] (the first rule that covers the host wins)
    workflowFor(rules, url) {
      const hostname = host(url);
      if (!hostname || !Array.isArray(rules)) {
        return '';
      }
      const rule = rules.find(({ site, workflow }) => workflow && patterns(site).some(pattern => covers(pattern, hostname)));
      return rule ? rule.workflow : '';
    },
  };
})();
