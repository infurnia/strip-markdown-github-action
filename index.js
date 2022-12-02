const core = require('@actions/core');
const removeMd = require('remove-markdown');

(async () => {
    try {
        const markdown = core.getInput('markdown');
        const plainText = removeMd(markdown);
        core.setOutput('text', plainText);
        console.log(`plainText: ${plainText}`);
        process.exit(0);
    } catch (error) {
        core.setFailed(error.message);
        process.exit(1);
    }
})();

