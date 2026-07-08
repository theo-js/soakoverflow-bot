// Paste this in devtools console to start the challenge and retry automatically after all fights are completed
// Use the intervalId to stop the interval

const NUMBER_OF_FIGHTS_IN_CURRENT_LEAGUE = 144;
const MIN_RANK_TO_REACH = 199;

const startChallengeBtn = document.querySelector('[data-test="ide-submit"]');
console.log('Starting challenge...');
startChallengeBtn?.click();

let intervalId = setInterval(() => {
    const latestFight = document.querySelector('.tv-viewer-container')?.lastElementChild?.firstElementChild;
    latestFight?.scrollIntoView();

    console.log(`Checking if fight #${NUMBER_OF_FIGHTS_IN_CURRENT_LEAGUE} has been completed...`);
    const completedFights = Array.from(document.getElementsByClassName('testcase-number')).map((element) => element.textContent);
    const hasCompletedChallenge = completedFights.includes(` ${NUMBER_OF_FIGHTS_IN_CURRENT_LEAGUE} `);
    if (!hasCompletedChallenge) return;

    const rank = Array.from(document.getElementsByClassName('ranking-player')).find(e => e.querySelector('.nickname-text')?.textContent === "theo-js")?.querySelector('.ranking-player-rank').textContent;
    console.log(`%cChallenge completed with rank ${rank} at ${new Intl.DateTimeFormat('en', { timeStyle: 'short' }).format(new Date())}`, 'color: lightgreen');
    
    if (parseInt(rank) <= MIN_RANK_TO_REACH) {
        // Do not restart if in top n
        clearInterval(intervalId);
        return;
    }

    console.log('Restarting challenge...');
    const overlay = document.querySelector('.mask.angular-animate');
    overlay?.click?.();
    startChallengeBtn.click();
}, 10000);