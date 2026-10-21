const $ = id => document.getElementById(id);
const signup = window.location.pathname === '/signup';
if (signup) {
  document.title = 'ScopeShield — Create your workspace';
  $('auth-title').textContent = 'Make room for better work.';
  $('auth-intro').textContent = 'Create an account to keep your published proposals in one place.';
  $('name-field').hidden = false;
  $('name').required = true;
  $('password').autocomplete = 'new-password';
  $('submit').textContent = 'Create your workspace →';
  $('switch-prompt').textContent = 'Already have an account?';
  $('switch-auth').href = '/login';
  $('switch-auth').textContent = 'Log in →';
}
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('submit').disabled = true;
  $('status').textContent = signup ? 'Creating your account…' : 'Logging in…';
  try {
    const response = await fetch(signup ? '/api/signup' : '/api/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('name').value, email: $('email').value, password: $('password').value }),
    });
    const result = await response.json();
    $('password').value = '';
    if (!response.ok) throw new Error(result.error || 'Could not sign in. Please try again.');
    window.location.assign('/app');
  } catch (error) { $('password').value = ''; $('status').textContent = error.message; }
  finally { $('submit').disabled = false; }
});
