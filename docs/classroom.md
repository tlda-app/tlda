# Classroom

Classroom is three things:

1. the book;
2. a schedule; and
3. homework submission, marking, and handback.

It is a thin overlay on the deployed tlda app. It is not a separate course-management
product.

Apart from those three features, it is the collaborative tlda whiteboard with user-owned
layers, with the book sitting on that whiteboard. The additional mechanism is layer
authorization and exchange: who may see or write each layer, and moving or copying selected
objects between layers.

## The book

The book is the classroom content. It may contain different documents or pages: prose,
assignments, slides, and recordings. An assignment is a page in the book, not a separate
handout project.

There is one authoritative homework source. The existing Quarto filters produce the
student-facing assignment and the solution view from that source. “Handout” is not a
classroom object and a disposable rendered handout project is not evidence that classroom
exists.

## The schedule

The schedule says when book content is current, due, or released. It points into the book;
it does not duplicate the content into course and assignment records.

Changing the schedule is the one update. The classroom view derives what students should
see now and what comes next from it.

## Homework submission, marking, and handback

Students submit their work at the assignment page in the book. The submission includes the
source and the rendered work.

The instructor marks by problem, moving through the students' answers while keeping the
instructor solution beside each answer. Marks and cross-document annotations belong to that
student's returned work.

Handback returns the marked exercise to the student in the book. Submission unlocks the
solution for that student.

## Access

A student's persistent token supplies identity and determines what that student may read or
write. Access is enforced on the document routes; a project or document name is never a
secret.

Each person owns a layer. The classroom also has shared and student–instructor layers. The
instructor can compose the layers they are authorized to see; a student can write on their
own layer and on shared layers. Moving or copying an object between layers preserves its
position on the whiteboard.

## What does not establish classroom

- A probe course, assignment row, or rendered fixture does not establish that the book is
  available as classroom.
- A registration form or gradebook table does not establish the submission-to-handback loop.
- Passing route or store tests does not establish the deployed browser workflow.
- Separate handout and solution projects are not the product model.

Classroom is present only when the real book and schedule drive a working deployed flow from
assignment page through submission, marking, and handback.
