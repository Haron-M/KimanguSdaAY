// Open the correct view based on URL parameter
window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'signup') {
        showView('signUpView');
    }
});
function togglePassword(inputId, btn) {
    const input = document.getElementById(inputId);
    const icon = btn.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
}

function handleAuthSubmit(e, type) {
    e.preventDefault();
    if (type === 'signup') {
        const pass = document.getElementById('signupPassword').value;
        const confirm = document.getElementById('confirmPassword').value;
        if (pass !== confirm) {
            alert('Passwords do not match. Please try again.');
            return;
        }
        alert('Demo account created! (No data was saved.) Redirecting to sign in...');
        showView('signInView');
        e.target.reset();
    } else {
        alert('sign-in successful!');
        window.location.href = "dashboard.html"
        e.target.reset();
    }
}