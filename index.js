const core = require('@actions/core');
const { Version3Client, AgileClient } = require('jira.js');
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
    "Continuous Integration": "🔁",
}

const jiraWorkflowOrder = ["To Do", "In Progress", "Dev", "Stage", "Preprod", "Done"];

const findJiraTicketIds = async (text) => {
    const ticketPattern = /\[[A-Z]{2,}-\d+\]/g;
    let matches = text.match(ticketPattern)
    if(matches) {
        matches = matches.map(x => {return x.slice(1, -1)});
    } else {
        matches = [];
    }
    return matches;
}

const fetchJiraTicketInfo = async (ticketID, jiraClient) => {
    try {
        jira = await jiraClient.issues.getIssue({ issueIdOrKey: ticketID });
        return {
            "id": ticketID,
            "summary": jira.fields.summary,
            "link": jiraClient.instance.defaults.baseURL + '/browse/' + ticketID,
            "status": jira.fields.status.name,
            "releases": jira.fields.fixVersions,
            "labels": jira.fields.labels
        }
    } catch {
        return {};
    }
}

const AddJiraInfoToReleaseNotes = async (notes, jiraInfo) => {
    const jiraInNotes = `\n[↗️${jiraInfo.id}](${jiraInfo.link}) ${jiraInfo.summary}`;
    notes = notes.replace(`[${jiraInfo.id}]`, jiraInNotes);
    notes = notes.replaceAll(`[${jiraInfo.id}]`, "");
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

    try {
        if(jiraWorkflowOrder.indexOf(currentStatus) < jiraWorkflowOrder.indexOf(moveTo)) {
            let transitions = await jiraClient.issues.getTransitions({issueIdOrKey: ticketId});
            transitions = transitions["transitions"];
            const transitionId = transitions.filter(x => x.name.includes(moveTo))[0].id;
            await jiraClient.issues.doTransition({issueIdOrKey: ticketId, "transition": {"id": transitionId}});
        } else {
            console.log(`[!] Cannot move Jira Ticket from ${currentStatus} to ${moveTo}. The order is violated`);
        }
    } catch {
        console.log(`[!] Some error occured while moving ticket ${ticketId}`);
    }
}

const assignSprintToTickets = async (jiraTicketIds, jiraSprintID, jiraAgileClient) => {
    const batch = 50;
    for(let i = 0; i < jiraTicketIds.length; i += batch) {
        let tickets = jiraTicketIds.slice(i, i + batch);
        try {
            await jiraAgileClient.sprint.moveIssuesToSprintAndRank({sprintId: jiraSprintID, issues: tickets});
            console.log(`[+] assigned sprint ${jiraSprintID} to jira tickets ${JSON.stringify(tickets)}`)
        } catch (err) {
            console.log(`[!] Could not assign sprint to jira ${JSON.stringify(tickets)} ${jiraSprintID} ${err}`);
        }
    }
}

const assignReleaseToTicket = async (jiraInfo, jiraReleaseID, releaseEnv, jiraClient) => {
    const ticketId = jiraInfo["id"];
    const existingReleases = jiraInfo["releases"];
    const existingLabels = jiraInfo["labels"];
    if(existingReleases.length == 0){
        try {
            let new_label = `${jiraInfo["new_release_name"]}_${releaseEnv}_cicd`;
            new_label = new_label.replaceAll(" ", "_");
            await jiraClient.issues.editIssue({issueIdOrKey: ticketId, fields: {fixVersions: [{"id": jiraReleaseID}], labels: [new_label, ...existingLabels]}});
            console.log(`[+] assigned release to jira ${ticketId}`)
            console.log(`[+] assigned label ${new_label} to jira ${ticketId}`)
        } catch (err) {
            console.log(`[!] Could not assign release to jira ${ticketId} ${jiraReleaseID} ${err}`);
        }
    } else {
        console.log(`[!] release "${existingReleases[0].name}" already exists for jira ${ticketId}`);
    }
}

const main = async () => {
    try {
        let markdown = core.getInput('markdown');
        const jiraEmail = core.getInput('jiraEmail');
        const jiraApiToken = core.getInput('jiraApiToken');
        const jiraBaseUrl = core.getInput('jiraBaseUrl');
        const releaseEnv = core.getInput('releaseEnv');
        const jiraSprintID = core.getInput('jiraSprintID');
        const jiraReleaseID = core.getInput('jiraReleaseID');

        const jiraClient = new Version3Client({
            host: jiraBaseUrl,
            authentication: {
                basic: {
                    email: jiraEmail,
                    apiToken: jiraApiToken
                }
            }
        });

        const jiraAgileClient = new AgileClient({
            host: jiraBaseUrl,
            authentication: {
                basic: {
                    email: jiraEmail,
                    apiToken: jiraApiToken
                }
            }
        });

        let versionInfo = "None";
        let projectInfo = "None";
        if(jiraReleaseID != "None") {
            versionInfo = await jiraClient.projectVersions.getVersion(jiraReleaseID);
            projectInfo = await jiraClient.projects.getProject({ projectIdOrKey: versionInfo.projectId });
        }
        let sprintInfo = "None";
        if(jiraSprintID != "None") {
            try {
                sprintInfo = await jiraAgileClient.sprint.getSprint({sprintId: jiraSprintID});
            } catch(e) {
                console.log("could not connect to jira agile: ", e);
            } 
        }

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

                if(jiraReleaseID != "None") {
                    jiraInfo["new_release_name"] = versionInfo.name;
                    await assignReleaseToTicket(jiraInfo, jiraReleaseID, releaseEnv, jiraClient);
                }
            } else {
                console.log(`[!] Could not find jira ticket ${jiraTicket}, ignoring it`);
            }
        }
        if(jiraSprintID != "None") {
            await assignSprintToTickets(jiraTicketIds, jiraSprintID, jiraAgileClient);
        }
        let jiraReleaseInNotes = "";
        if(jiraReleaseID != "None") {
            let releaseLink = `${jiraBaseUrl}/projects/${projectInfo.key}/versions/${jiraReleaseID}`;
            let releaseName = versionInfo.name;
            jiraReleaseInNotes = `**Release**:    [${releaseName}](${releaseLink})`;
            console.log(`[*] Jira Release: ${releaseName} -> ${releaseLink}`);
        }

        let jiraSprintInNotes = "";
        if(jiraSprintID != "None") {
            let sprintLink = `${jiraBaseUrl}/jira/software/c/projects/INFURNIA/boards/21?sprint=${jiraSprintID}`;
            let sprintName = sprintInfo.name;
            jiraSprintInNotes = `**Sprint**:    [${sprintName}](${sprintLink})`;
            console.log(`[*] Jira Sprint: ${sprintName} -> ${sprintLink}`);
        }
        markdown = jiraSprintInNotes + '\n' + jiraReleaseInNotes + '\n' + markdown;

        markdown = await beautifyNotes(markdown);
        const slackifyMarkdown = removeMd(markdown);
        core.setOutput('text', slackifyMarkdown);
        process.exit(0);

    } catch (error) {
        core.setFailed(error.message);
        process.exit(1);
    }
}

main();
