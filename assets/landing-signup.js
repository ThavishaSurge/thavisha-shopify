/**
 * Landing signup: mirrors submissions to a Google Sheet.
 *
 * Shopify's {% form 'customer' %} tag posts natively and reloads the page, and it
 * only persists email/first_name/last_name/tags. So the flow is:
 *
 *   1. on submit  -> stash the full payload (including Sheet-only fields) in sessionStorage
 *   2. native POST -> Shopify creates the customer and reloads the page
 *   3. on reload  -> if Shopify reported success, POST the stash to Apps Script, then clear it
 *
 * Writing the row only in step 3 means the Sheet never gains a row for a submission
 * Shopify rejected. If the form came back with errors the stash is replayed into the
 * inputs instead, so the customer does not have to retype the Sheet-only answers.
 */
class LandingSignup extends HTMLElement {
  connectedCallback() {
    this.form = this.querySelector('form');
    this.endpoint = this.dataset.endpoint;
    this.storageKey = `landing-signup:${this.dataset.sectionId}`;

    if (this.querySelector('[data-signup-success]')) {
      this.flush();
      return;
    }

    if (!this.form) return;
    this.restore();
    this.form.addEventListener('submit', () => this.stash());
  }

  /** Reads every field, including the ones Shopify will drop. */
  collect() {
    const payload = {
      // Stable across retries, so Apps Script can reject a duplicate append.
      'Submission ID': this.submissionId(),
      'Submitted at': new Date().toISOString(),
      'Landing page': window.location.pathname,
    };

    const named = {
      'First name': 'contact[first_name]',
      'Last name': 'contact[last_name]',
      Email: 'contact[email]',
    };

    for (const [column, name] of Object.entries(named)) {
      const input = this.form.querySelector(`[name="${name}"]`);
      if (input) payload[column] = input.value.trim();
    }

    this.form.querySelectorAll('[data-extra-field]').forEach((input) => {
      const column = input.dataset.key;
      if (!column) return;
      payload[column] = input.type === 'checkbox' ? (input.checked ? 'Yes' : 'No') : input.value.trim();
    });

    return payload;
  }

  submissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  stash() {
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.collect()));
    } catch (error) {
      // Private browsing or a full quota. The customer record still gets created.
      console.warn('landing-signup: could not stash submission', error);
    }
  }

  /** Repopulates Sheet-only fields after Shopify bounces the form with errors. */
  restore() {
    const stashed = this.read();
    if (!stashed) return;

    this.form.querySelectorAll('[data-extra-field]').forEach((input) => {
      const value = stashed[input.dataset.key];
      if (value === undefined) return;
      if (input.type === 'checkbox') {
        input.checked = value === 'Yes';
      } else {
        input.value = value;
      }
    });
  }

  read() {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  clear() {
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch (error) {
      /* nothing to do */
    }
  }

  /** Shopify accepted the customer, so the row is safe to write. */
  async flush() {
    const payload = this.read();
    if (!payload) return;

    if (!this.endpoint) {
      this.clear();
      return;
    }

    try {
      // text/plain keeps this a simple request: Apps Script web apps answer the
      // CORS preflight with a redirect that browsers refuse to follow.
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        keepalive: true,
      });
      this.clear();
    } catch (error) {
      // Leave the stash in place so a refresh retries it.
      console.warn('landing-signup: Sheet sync failed', error);
    }
  }
}

customElements.define('landing-signup', LandingSignup);
