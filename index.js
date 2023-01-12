const core = require('@actions/core');
const { Version3Client } = require('jira.js');
const removeMd = require('slackify-markdown');

const releaseEmojis = {
    "Features": "✨",
    "Bug Fixes": "🐞",
    "Reverts": "↩️",
    "Code Refactoring": "♻️",
    "Performance Improvements": "⚡",
    "Documentation": "📝",
    "Styles": "🎨",
    "Tests": "✅",
    "Build System": "👷",
    "Continuous Integration": "💚",
}

const jiraWorkflowOrder = ["To Do", "In Progress", "Dev", "Stage", "Preprod", "Done"];

const findJiraTicketIds = async (text) => {
    const ticketPattern = /\[[A-Z]{2,}-\d+\]/g;
    const matches = text.match(ticketPattern).map(x => {return x.slice(1, -1)});
    return matches;
}

const fetchJiraTicketInfo = async (ticketID, jiraClient) => {
    try {
        jira = await jiraClient.issues.getIssue({ issueIdOrKey: ticketID });
        return {
            "id": ticketID,
            "summary": jira.fields.summary,
            "link": jiraClient.instance.defaults.baseURL + '/browse/' + ticketID,
            "status": jira.fields.status.name
        }
    } catch {
        return {};
    }
}

const AddJiraInfoToReleaseNotes = async (notes, jiraInfo) => {
    const jiraInNotes = `\n[↗️${jiraInfo.id}](${jiraInfo.link}) ${jiraInfo.summary}`;
    notes = notes.replaceAll(`[${jiraInfo.id}]`, jiraInNotes);
    return notes;
}

const beautifyNotes = async (notes) => {
    for(const commitType in releaseEmojis) {
        notes = notes.replaceAll(commitType, `${releaseEmojis[commitType]} ${commitType}`);
    }
    return notes;
}

const moveJiraTicket = async (jiraInfo, releaseEnv, jiraClient) => {
    const ticketId = jiraInfo["id"];
    const envToJiraStatus = {
        "stage": "Stage",
        "preprod": "Preprod",
        "production": "Done"
    };
    const moveTo = envToJiraStatus[releaseEnv];

    // Ensure we are not moving it backwards
    const currentStatus = jiraInfo["status"];

    if(jiraWorkflowOrder.indexOf(currentStatus) <= jiraWorkflowOrder.indexOf(moveTo)) {
        let transitions = await jiraClient.issues.getTransitions({issueIdOrKey: ticketId});
        transitions = transitions["transitions"];
        const transitionId = transitions.filter(x => x.name.includes(moveTo))[0].id;
        await jiraClient.issues.doTransition({issueIdOrKey: ticketId, "transition": {"id": transitionId}});
    } else {
        console.log(`[!] Cannot move Jira Ticket from ${currentStatus} to ${moveTo}. The order is violated`);
    }

}

const main = async () => {
    try {
        let markdown = core.getInput('markdown');
        const jiraEmail = core.getInput('jiraEmail');
        const jiraApiToken = core.getInput('jiraApiToken');
        const jiraBaseUrl = core.getInput('jiraBaseUrl');
        const releaseEnv = core.getInput('releaseEnv');

        const jiraClient = new Version3Client({
            host: jiraBaseUrl,
            authentication: {
                basic: {
                    email: jiraEmail,
                    apiToken: jiraApiToken
                }
            }
        });

        jiraTicketIds = await findJiraTicketIds(markdown);
        for(const jiraTicket of jiraTicketIds) {
            // Find jira info
            const jiraInfo = await fetchJiraTicketInfo(jiraTicket, jiraClient);
            if("id" in jiraInfo) {
                // Add jira information to release notes
                // i.e. Summary and link to the jira
                markdown = await AddJiraInfoToReleaseNotes(markdown, jiraInfo);

                // Move the jira ticket to correct status
                await moveJiraTicket(jiraInfo, releaseEnv, jiraClient);
            } else {
                console.log(`[!] Could not find jira ticket ${jiraTicket}, ignoring it`);
            }
        }

        markdown = await beautifyNotes(markdown);
        const slackifyMarkdown =removeMd(markdown);
        core.setOutput('text', slackifyMarkdown);
        process.exit(0);

    } catch (error) {
        core.setFailed(error.message);
        process.exit(1);
    }
}

main();
