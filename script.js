// Mobile Menu Toggle
const menuBtn = document.getElementById('menuBtn');
const navLinks = document.getElementById('navLinks');

menuBtn.addEventListener('click', () => {
    navLinks.classList.toggle('active');
});
document.querySelector('.btn.btn-gold').addEventListener('click', () => {
    window.location.href = 'auth.html?view=signup';
}
)
// Close mobile menu when clicking a link
document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', () => {
        navLinks.classList.remove('active');
    });
});

// Hero Slider Logic
let currentSlideIndex = 0;
const slides = document.querySelectorAll('.hero-slide');
const dots = document.querySelectorAll('.dot');
let slideInterval;

function showSlide(index) {
    slides.forEach(slide => slide.classList.remove('active'));
    dots.forEach(dot => dot.classList.remove('active'));

    currentSlideIndex = (index + slides.length) % slides.length;
    slides[currentSlideIndex].classList.add('active');
    dots[currentSlideIndex].classList.add('active');
}
// Member Counter Logic
function updateMemberCount() {
    const count = localStorage.getItem('memberCount') || 0;
    document.getElementById('memberCount').textContent = count;
}

// Call on page load
updateMemberCount();
function nextSlide() {
    showSlide(currentSlideIndex + 1);
}

function currentSlide(index) {
    showSlide(index);
    resetInterval();
}

function resetInterval() {
    clearInterval(slideInterval);
    slideInterval = setInterval(nextSlide, 5000);
}

// Start auto slide
slideInterval = setInterval(nextSlide, 5000);

// Modal Functions
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// Window click to close modal
window.addEventListener('click', (e) => {
    const modal = document.getElementById('joinModal');
    if (e.target === modal) {
        closeModal('joinModal');
    }
});

function handleFormSubmit(e) {
    e.preventDefault();
    alert('Thank you! Your message has been sent successfully. We will reach out to you soon.');
    e.target.reset();
}

function handleModalSubmit(e) {
    e.preventDefault();
    let count = parseInt(localStorage.getItem('memberCount') || 0);
    count++;
    localStorage.setItem('memberCount', count);
    updateMemberCount();
    alert('Welcome to Kimangu AY! Your details have been received.');
    closeModal('joinModal');
    e.target.reset();
}
// Scroll Reveal Animation
const revealElements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right');

const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            revealObserver.unobserve(entry.target);
        }
    });
}, {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
});

revealElements.forEach(el => revealObserver.observe(el));
function showView(viewId) {
    document.querySelectorAll('.auth-view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}
