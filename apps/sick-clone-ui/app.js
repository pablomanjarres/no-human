document.addEventListener('DOMContentLoaded', () => {
    
    // Mobile Menu Toggle
    const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
    const mainNav = document.querySelector('.main-nav');
    
    if(mobileMenuToggle && mainNav) {
        mobileMenuToggle.addEventListener('click', () => {
            mainNav.classList.toggle('active');
        });
    }

    // Cookie Banner
    const cookieBanner = document.getElementById('cookie-banner');
    const btnNecessary = document.getElementById('cookie-necessary');
    const btnAccept = document.getElementById('cookie-accept');
    
    if (!localStorage.getItem('sick_cookie_consent')) {
        setTimeout(() => {
            if(cookieBanner) cookieBanner.classList.add('show');
        }, 1000);
    }
    
    const dismissBanner = () => {
        if(cookieBanner) cookieBanner.classList.remove('show');
        localStorage.setItem('sick_cookie_consent', 'true');
    };

    if(btnNecessary) btnNecessary.addEventListener('click', dismissBanner);
    if(btnAccept) btnAccept.addEventListener('click', dismissBanner);

    // Smooth Scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const targetId = this.getAttribute('href');
            if(targetId === '#') return;
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                e.preventDefault();
                targetElement.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });

});


