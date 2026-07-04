// Paste this in devtools console to start the challenge and retry automatically after all fights are completed
// Use the intervalId to stop the interval

const startChallengeBtn = document.querySelector('[data-test="ide-submit"]');
console.log('Starting challenge...');
startChallengeBtn?.click();

let intervalId = setInterval(() => {
    console.log('Checking if fight #130 has been completed...');
    const completedFights = Array.from(document.getElementsByClassName('testcase-number')).map((element) => element.textContent);
    const hasCompletedChallenge = completedFights.includes(' 130 ');
    if (!hasCompletedChallenge) return;

    const rank = Array.from(document.getElementsByClassName('ranking-player')).find(e => e.querySelector('.nickname-text')?.textContent === "theo-js")?.querySelector('.ranking-player-rank').textContent;
    console.log(`Challenge completed with rank ${rank}`, 'Restarting challenge...');
    
    const overlay = document.querySelector('.mask.angular-animate');
    overlay?.click?.();
    testBtn.click();
    
}, 10000);