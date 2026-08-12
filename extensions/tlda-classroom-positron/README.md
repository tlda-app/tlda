# tlda Classroom for Positron

This extension contributes **Homework: Zip for submission** for an open QMD
handout. The command saves the document, checks that it contains answer blocks,
checks that every referenced local image exists inside the assignment folder,
then opens a Save dialog for a ZIP containing the QMD and those images.

The server remains authoritative for hand-in validation. In particular, the
offline extension does not guess whether text beneath an answer block was typed
by the student: that check requires the frozen handout revision held by the
server.
