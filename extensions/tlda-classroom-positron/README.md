# tlda Classroom for Positron

This extension contributes **Homework: Zip for submission** and **Homework:
Submit** for an open QMD handout. Both commands save the document, check that it
contains answer blocks, and check that every referenced local image exists
inside the assignment folder. Zip opens a Save dialog for a ZIP containing the
QMD and those images. Submit sends that archive to the classroom server named
in the handout; the first submission prompts for the token from registration
and stores it in Positron's secret storage.

The server remains authoritative for hand-in validation. In particular, the
offline extension does not guess whether text beneath an answer block was typed
by the student: that check requires the frozen handout revision held by the
server.
