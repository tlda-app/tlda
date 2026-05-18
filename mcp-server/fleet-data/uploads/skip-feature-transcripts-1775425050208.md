# Skip's Words: Complete Feature Transcripts

Your verbatim messages on each feature, pulled from fleet chat logs. This is what YOU said — not agent interpretations.

---

## VOICE / WHISPER

*(Most voice feedback was April 5 via fleet chat to guidance. Earlier voice work was in terminal sessions outside fleet chat.)*

### April 5, 12:59 AM — on whisper approach
> like what was wrong with the first thing they tried except the fucking repeats?

### April 5, 1:03 AM — on shift-twice workaround
> But apparently I have to. Have you thought about the fact that if I hit shift. Twice. That fixes things, so maybe fucking enter is shift. And enter. Fucking. Shift, enter, shift or whatever.

### April 5, 1:04 AM — opus-fixer deployed broken build
> Yes, Dick. What the fuck is wrong with you? Yeah, I do what I'm asked to do before reporting something. You don't because you're an asshole.

### April 5, 1:05 AM — spawn research instead of guessing
> Can you spawn an agent that's like fucking Whisper Googler? Like, we're not implementing a fucking new or weird feature here. And yet it is profoundly broken fucking forever.

### April 5, 1:36 AM — whisper eats typed text
> whisper eats my text

> it replaced my typing with (keyboard clicking)

### April 5, 1:39 AM — text comes back after erasing
> Yeah, voice seems to work pretty well now. But... That's not the coolest thing. I mean like, I can live with this for now, but like... Don't eat my text.

### April 5, 1:41 AM — editing gets overwritten
> ...I erase it. And then it just fucking comes back. So yeah, whisper seems to work great as long as I never want to do anything but talk. But like, again, I can live with it, but it's like not cool.

### April 5, 1:42 AM — message duplication
> And now it just like duplicated my message to fucking prompt and then it ate that so That's great Something's very wrong

### April 5, 1:44 AM
> What about duplication

### April 5, 1:45 AM
> If you look up and chat You may notice that I said exactly the same fucking thing once Twice Do you think I said exactly the same fucking thing twice

### April 5, 1:46 AM — clarifying the bug
> It's not a send duplication bug

> It's the last message getting entered in my fucking text field

> It just seems to happen sometimes

> No like I say a sentence I fucking hit enter And then a minute later my fucking text field that's the same fucking sentence there And then like I guess if I talk after that the sentence just fucking disappears but I don't know

### April 5, 1:47 AM
> A minute might have been three seconds.

### April 5, 1:48 AM — don't iterate with me
> This is exactly the same shit that I just went through with that last fucker. I don't want to work on this with you... This project seems like it's a fucking nightmare.

### April 5, 1:50 AM — what Enter should do (x2, duplication in action)
> Regarding Whisper, yeah, you absolutely need to put someone on it because now I have to fucking hit shift twice every time I wanna fucking send a message... just fucking do what happens when I hit shift twice when I fucking hit enter

### April 5, 1:51 AM
> Yeah, you might want to put them on fucking duplication too.

> Like look, Whisper can fucking block for three seconds or do whatever the fuck it needs to do. I don't give a shit.

### April 5, 1:53 AM — use my words as the spec
> I don't want them to make a task list because they're gonna fuck it up. They need to do... like research... they need vignettes, like they need what I fucking said. Because I'm sick of being mischaracterized. And I don't wanna fucking have to re-specify shit that I already fucking laboriously fucking specified.

### April 5, 2:06-2:07 AM — testing after deploy
> Okay, I'm just gonna say some shit for a while.

> in typed this

### April 5, 2:08 AM — Right Shift sending messages
> Why the fuck is it sending when I hit shift? Like, something fucking got garbled, right? I said hit when I hit shift twice, like, I can fucking talk again, right? Because it like, restarts some bullshit. So I meant fucking restart some bullshit when I fucking press enter, not fucking, like, if I hit shift to fucking allow me to fucking speak after I've typed something, fucking send it.

### April 5, 2:10 AM ��� reload lost dictation
> What the fuck dude? Like, great. Okay, thanks for giving me another probably fucking broken, whisper based fucking chat. Cool. Like, now I'm gonna like hit enter and then I'll never be able to speak again or something. Oh, or it'll just fucking like shit will disappear and pop into existence like whenever the fuck it feels like. So I have just like the experience of being like terrified, right? That I just like lost all the fucking speech and I'm gonna have to say all this shit again. Um, which I did because you fucking refreshed without fucking asking me.

### April 5, 2:14 AM — THE USER STORY
> It feels like a lot of these like Misimplementations or miscommunications are arising Because you guys just want to fucking Change something and have the problem go away But you like get that when the problem goes away for you You create a problem for me of telling you that there's still a fucking problem like that's rude as fuck like I Don't know if you're unable to like infer the like user story From me like describing my experience from my like tests for my like Entering the same text repeatedly because it just fucking shows up at my prompt But like I'm not asking for anything fucking complicated like I Just Wanna fucking say stuff Maybe edit it Maybe continue saying stuff Hit fucking enter and then have the process just be fucking new again And I don't give a shit about latency like you can wait to send You can wait to fucking let me type or speak again But like I don't hit fucking buttons all the time And Like It's not a complicated like user story, you know and you guys said that you have like a Fucking test rig where you can play audio through shit Presumably you can like play some fucking audio and like type and hit enter and fucking like Wait and just like like look you have the timing of all this shit Like do you want you want just like record me talking for a while? Should we just have complete audio recording so you guys can debug your shitty fucking whisper implementation? That like replace something probably fucking work better than this We've been torturing me with for like two fucking hours like Can you test this shit or not The fucking voice interpretation from whisper is fucking great so like cool That's the thing you said you couldn't test Fucking like the rest of it is not

### April 5, 3:48 PM — checking on voice
> did we have someone making shit work?

> voice?

### April 5, 3:54 PM — voice broken in Chrome
> Voice doesn't work in Chrome at all. Um... And great, but like... I don't- I don't know how to put this. Like... I'm using Safari, it's okay. Like... The brokenness of this shit is really upsetting me... just get me fucking... a coherent set of tools that actually fucking works, okay?

### April 5, 3:56 PM
> You are being a complete dick. Chrome has never fucking worked. Don't say reload to me, fucking ever.

### April 5, 4:20 PM — brief success then broken
> Does this work? Okay, yeah this works. Yes.

### April 5, 4:21 PM
> Hello, okay. Yeah, it seems pretty fucked actually Like I had to hit shift twice so fucking Talk again

> When I hit enter, do what happens when I hit shift twice.

### April 5, 4:22 PM
> Stop it. You are being a huge dick right now.

### April 5, 4:24 PM — THE REAL SPEC
> Undo all of your changes which were incredibly rude and based on the premise that I didn't know what the fuck was going on. Yes, enter should stop recording send and fucking start recording. Okay, like I'm just saying there's something in state that gets broken when I hit enter and it gets fixed when I hit shift twice. That is not a historical behavior. I never wanted any behavior specific to hitting shift twice. The historical behavior that exists existed was again an agent being rude and acting like I didn't know what the fuck I was talking about. What I am saying is that if we can make something work as long as I hit a key twice we can make something work without me hitting the key twice.

### April 5, 4:26 PM
> All of the things we've debugged. The fucking message doubling phenomenon. The fucking just like turning off and needing to be restarted. That's still an issue in Chrome. I don't know if you in some way special case your Safari fixes. Fix it. Test it. For real. Like we have talked about this over and fucking over. There is no excuse for behavior. This fucked up. It has nothing to do with something untestable. It's just lazy half-assed programming and failure to test.

### April 5, 4:27 PM
> I was literally describing what just happened. Again, like if I was going to say, fuck it, yes, all of those things just happened. None of those things were successfully fixed.

### April 5, 4:28 PM
> Apparently it's not Safari specific because in Safari I also have to hit shift twice between messages. Look I don't want you to work on this because you fucking suck right now. Just spawn a fucking Opus agent whose job is to actually fucking fix this and test it.

### April 5, 4:29 PM
> (tapping) The first two things on your fucking list. Zero times have I said anything about transcription coming back wrong or garbled. Your attitude is fucking heinous, dude.

---

## HUD / LAYOUT

### March 24, 12:52 PM — original idea
> so dockview kind of works but it's kind of annoying. so a like, stupid idea---what would it look like to make fleet a very complex tldraw shape---like have it be tldraw-native-ui

### March 24, 12:54 PM
> 'this is a terrible idea' is a reasonable answer here

### March 24, 1:00 PM
> kind of inconsistent feel---like, what happens when i drag this there feels unpredictable and like, not well signed/ghosted --- and fundamentally the like, panels layout feels kind of constraining; like i'm always flipping tabs around to focus the right thing

### March 24, 1:06 PM
> and like, conceptually we could window into fleet from any doc using like, the tlda refviewer with the default being like, it living in the scratch doc

### March 24, 1:21 PM — priorities
> i think we can skip phase0, fwiw---dockview isn't that bad, it's just not the future i want. terminal...tbh like, i'd love to have that working but i don't use it yet---still easier to drop into terminal.app---so no big deal really getting that integrated perfectly or even really at all. re questions:
> 1. i think like, it's like a custom shape we use in any doc. prob a book initially

### March 24, 1:25 PM
> one question is like, we might want it to float vs. be fixed in place? we could do that with a like, refviewer-type window, but is there a floating tldraw shapes thing?

### March 24, 1:28 PM
> problem with 1 is we like, lose tldraw-style spatial stuff and layout control?

> maybe we do a floating refviewer?

### March 24, 1:30 PM
> like it is in a fixed place and we have a hud-layer view of it?

### March 24, 1:31 PM
> yeah. and like, there'd be a simple move operation that's like 'pick it up and drop it where the hud is'

### March 27, 2:57 PM
> useful agents panel [informative, dragging]; refviewer [just too small. maybe the thing to do is have it be like, sort of full-column-size in one margin or the other. try left for now? and like, dechromed? like, fullscreening tlda panels in the refviewer...

### March 27, 2:58 PM
> dechromed refviewer, I mean. and scroll in chat/clicking on stuff should work?

### March 27, 3:12 PM
> like, refviewer bg should be invisible [maybe very faint on hover or something] so it looks like the chat stuff is just floating. theme should match tlda's

### March 27, 3:16 PM
> oh. tlda panels need to capture scroll. right now, scroll on chat pans the doc in the refviewer

### March 27, 3:17 PM
> I think we can lock pan in the refviewer for this since we're full-sizing

### March 27, 3:21 PM
> scroll is locked in the refviewer, but neither the refviewer version nor the on-canvas shape has scrollable chat.

### March 27, 4:13 PM
> cool. scroll works in the refviewer version. not the like, on canvas shape but who cares about that for now

### March 27, 4:16 PM
> I mean maybe we should have a visual indicator [like a faint background for the whole refviewer] of edit mode so I can tell?

### March 27, 4:20 PM
> the refviewer does seem to obstruct the toolbar though

> perhaps, if we're doing the refviewer on the left, the toolbar should go elsewhere

### March 27, 5:36 PM
> like the empty parts of the hud should be transparent to clicks probably?

### March 27, 5:54 PM
> like, it's also really hard to do layout. two issues. 1. it is hard to grab the fleet shapes. not sure what that's about. have to just like, *nail* the click on the outline. 2. the hud overlaps and steals pointer events from the on-canvas version. it should disappear when the canvas version is visible or something like that

### March 27, 6:37 PM
> for you, seems like we need that container shape? otherwise the refviewer seems to like, blow up

### March 27, 6:49 PM
> the refviewer bounding box is wrong i think. it's like consuming the whole paper, fucking the zoom

### March 27, 6:52 PM
> basically i wanted the fleet agents panel but like, proper tldraw

### March 28, 9:48 AM
> The shape should auto-resize taller when the textarea grows — that way nothing gets occluded and the textarea effectively grows "down."

### March 29, 1:48 AM
> to control the distance of the fleet hud from the right margin, we can have a 'margin shape' or like 'fake page shape' we can position relative to the on-canvas fleet shapes. maybe there's a way to do vertical position like that too. 4. do we have to use rounded rects for shapes? snapped-together rounded rects look weird. 5. agents-panel label brightness is a bit excessive---let's tone down the opacity to like, 3/4 of the current level

### March 29, 1:51 AM
> ghost txt in search field is like amber or something? like, use standard fleet colors. it's like the new ui --- agents panel too---has kind of forgotten the 'don't draw the eye' principle. like, the bright dots next to agents vs. like, just dimming their names to show lack of activity. that's a regression from our old design

### March 29, 1:53 AM
> one thing I just caught too. I get the like, chat-filter overlay when I drag anything over chat---should be only labels

### March 29, 3:11 AM
> like, the on-canvas version of the fleet ui is only semi-usable because scroll doesn't work right. which is fine, but it means we need the hud like, working properly

### March 29, 3:17 AM
> cool. ok. layout-wise, like, our pills need to be aware of each other and of the tldraw watermark so they're visible/not overlaid. perhaps we can like, figure out how to lay those guys out.

### March 29, 9:02 PM
> chat scroll is, however, working properly on the hud, but not the on-canvas shape. I can live with that

### April 4, 9:47 PM — HUD broken after merge
> that indicator. shit clips; im now stuck with a broken layout

### April 4, 9:47 PM
> the fucking layout button is offscreen so it can't be dragged back like

### April 4, 9:48 PM
> the fucking 'new layout' button in the toc doesn't fix it

### April 4, 9:49 PM
> the fucking copy button doesn't work anymore either

> fuck this

> i am so fucking angry

### April 4, 9:51 PM
> just do it. read the fucking feature list too like. fuck. spawn someone to read logs, make a list of features and identify what does and doesn't work consistently, what was and wasn't merged improperly. this isn't my fucking job

### April 4, 9:52 PM
> apparently you don't know what features there are so like, prob have them photograph scenes from the fucking app and identify them with features

### April 4, 9:54 PM
> look i understood that no feature was allowed to be completed without qa approval. what's with that? that isn't happening

### April 4, 9:55 PM
> respawn guidance and tell them about the fucking nightmare that's happened

> ask how to try to make it stop happening

### April 4, 9:57 PM
> please spawn someone to wipe my tldraw store on every project entirely

### April 4, 9:57 PM
> or just do it. whatever. every fucking document is broken like fucking invisibly by some misimplemented feature

### April 4, 9:57 PM
> and we were supposed to stop the silent failures

> wtf happened there?

### April 4, 9:58 PM
> fucking balancing act just won't load agents tell me it's a fucked shape. other pages like that?

### April 5, 2:03 AM — THE HUD LAYOUT SPEC
> This is trash. You can't collect everything I said about, like, what something is supposed to look like ever. Or you can, but you have to unify it. Like, layout has gone through proposal after proposal. So let me just fucking do it again. And if you make me do it again, I will be so fucking angry. So like write this shit down or something, okay? I want to be able to control the size of the HUD. I want to be able to control the layout of the things in the HUD. And I don't want it to be a complete fucking nightmare. So what I settled on was I want to have a fucking button activated fucking layout mode in which the HUD appears as a virtual container or a transient container, an actual container, that can be resized with everything within it scaling to fit the fucking thing. In that mode, I also want the shapes within the HUD to be fucking like editable. Sorry, not editable, like resizable, movable, reshapable. So I want them to just behave like rectangles that just happen to have some fucking textual texture on them. Okay, I don't want to, when I drag them, I want them to move. I don't want to fucking get a bunch of chips from chat and stuff. Okay, I don't want there to be an actual long lasting container shape because that has proven to be a fucking nightmare. I don't want there to be any clipping. I want things to automatically resize.

### April 5, 2:18 AM — safe progress
> can you think through like what can be done to like hopefully make progress on these things? Hopefully get like a demonstration of their success without like just jerking me around again. Um, that can't possibly break anything. Like that can't possibly break anything part is really fucking easy. You just do it on fucking work trees and you don't fucking commit to main. You don't merge to main and you don't fucking build broken shit into the fucking bundle that we use.

---

## TERMINAL

### March 22, 1:58 PM
> dude is terminal-agent running?

### March 24, 1:21 PM
> terminal...tbh like, i'd love to have that working but i don't use it yet---still easier to drop into terminal.app---so no big deal really getting that integrated perfectly or even really at all.

*(apps recorded: "terminal is low priority")*

### March 29, 7:31 PM
> dude like, the terminal---where this shit comes from---doesn't have flicker like this

### March 29, 7:32 PM
> you clear the thinking indicator when it stops showing in terminal

### March 29, 7:34 PM
> dude. no thrashing now. talk to me. terminal doesn't get rid of thinking because of tools. it stays until idle. I just want the same indicator as terminal restyled

### March 29, 7:43 PM
> cool. one nice fleet feature would be like, both hard and soft interrupts on esc like in terminal. soft like, passes messages through 'thinking...' as it does in terminal. not entirely sure what that means but like, it does something

### March 29, 7:44 PM
> identical to in terminal ideally

### March 29, 7:50 PM
> dude I get no fleet messages from apps in my chat. I see them happening in terminal

---

## PLAYBACK

### March 19, 11:04 PM
> so i'd like to do a 'making of' playback for this talk, which i think started on sunday with a couple agents and then picked up today with slides-agent. Some stuff happened in terminal/not tmux, so basically...

### March 22, 12:07 AM
> playback design doc? that's 2 weeks old

### March 27, 3:34 PM
> would want like, other panels. search, playback, etc. that can wait for now

*(Only 3 messages from Skip on playback. Feature was largely agent-driven.)*

---

## CHIPS / DRAG-DROP

### March 22, 3:57 AM
> not---you talk to them---but they're saying that to themself and ignoring my messages. and also dude. drag is FUCKED. like, ok we can wait to fix it, but don't tell me it's fixed. Still chip + raw text on every drag.

### March 22, 6:44 AM
> ok. so codemirror ruined chips/drag, is that the deal?

### March 22, 2:50 PM
> can you like, actually get useful fixes in by then

### March 27, 3:27 PM
> it's broken in the dash. drags lead to complex text + attachments where it was supposed to be chips in-place. on a blank field, image attachment doesn't work, etc. it totally sucks

### March 28, 9:51 AM
> like, it looks like a pill

### March 29, 5:09 PM
> we just want a chip. or at least, a much smaller preview

---

## FOOT CONTROL / GESTURES

### April 5, 2:21 AM
> Can you get someone to figure out this fucking like... Sounds as gestures thing, figure out what our options are. You know, I'm really trying to set up stuff so I don't have to type and like... Don't have to mouse and shit and like... This is a necessary part

### April 5, 2:22 AM
> They should be aware of what's happened within my thread with controls.

### April 5, 1:11 AM — tongue clicks / classifier
> ...part of the foot cursor idea was to also have like click and enter and shit um when you're working on your plan having like implementing like a classifier you know like wavelets or whatever shit for things like tongue clicks...

> is there a way to use [whisper for non-speech sounds]... are we reinventing the wheel by implementing a classifier on our own

---

## QA PROCESS

### March 26, 11:41 PM
> Should that be formalized or handled through manager/qa? Someone aside from me should be aware of the distinction between changing a proof and changing the result.

### March 27, 5:56 PM
> like can you task someone with doing qa for you so you piss me off less?

### March 27, 5:59 PM
> i wanted a QA agent for your behavior

### March 27, 6:00 PM
> ok. so can we talk qa for a sec? i don't want to keep getting jerked around

### March 27, 6:22 PM
> is it technically possible for you to screenshot the drag process? before, during, after?

### March 27, 7:54 PM
> is your qa guy working?

### March 27, 7:56 PM
> that's why we had a qa guy

### March 27, 7:59 PM
> dude i think qa needs to be cced

### March 27, 8:19 PM
> delegate both. just manage, qa, commit

### March 27, 8:54 PM
> given the frequency with which you do this, perhaps you should write a script that opens tlda in playwright with auth

### March 28, 1:34 AM
> ok. first order of business is fixing qa. i want to have an mcp function called 'wiretap' that takes a 'to' and a 'from', both filter expressions interpreted exactly like chat, which agents can use to listen in on messages

### March 29, 7:39 AM
> ok. I'm still seeing this. test, report. don't make me do qa for you

### April 4, 9:54 PM
> look i understood that no feature was allowed to be completed without qa approval. what's with that? that isn't happening

---

## SILENT FAILURES / INFRASTRUCTURE

### March 27, 3:00 PM
> right. clicking on markdown links has been broken [or at least, the morning report link] in dockview-fleet so could be either a new or old problem

### March 27, 5:44 PM
> ok. tlda is currently broken, but that's your guy working on tldraw-native agents panel? let me know when it's done

### March 28, 1:23 AM
> this is a shitty patch. 'likely'? that's how you develop broken unfixable garbage

### March 28, 1:54 AM
> this is how shit silently breaks. this is not a library. it's not a programming language. it's an app. we upgrade everything at once

### March 28, 2:29 AM
> YOU ARE SHOWING ME A BROKEN LINK OVER AND OVER

> dude you're not providing a screenshot with a path that renders in fleet

### March 28, 2:34 AM
> do we need to restart mcp?

> do we need to restart server?

### March 29, 1:49 AM
> ok. still no restart? what's up?

### March 29, 9:09 PM
> button is broken

### March 29, 9:25 PM
> uh, fleet restart map doesn't work

### March 29, 9:27 PM
> post mcp restart seems like your channel is dead

### March 29, 9:39 PM
> you need a session restart for the web socket to get fixed

### April 4, 9:57 PM
> every fucking document is broken like fucking invisibly by some misimplemented feature

> and we were supposed to stop the silent failures

> wtf happened there?

### April 4, 9:58 PM
> fucking balancing act just won't load agents tell me it's a fucked shape. other pages like that?

### April 5, ~4:35 PM (today)
> Our shit cannot fail silently. I lose work when that happens. And when it does happen, agents act like I'm fucking crazy and they tell me to try broken shit all the time. I need the ability to look into this myself easily and fix it and agents need to fucking see it all instead of seeing one piece at a time. So basically we all need to just see it all, what the problems are and that there are problems.

> I can't be fucking restarting all my agents MCPs and all this shit over and over

---

## BROWSER TOOLS / AGENTS SELF-VERIFY

### March 27, 4:27 PM
> when you say screenshot confirms

### March 27, 4:28 PM
> fucking show me the screenshot in chat

### March 27, 4:47 PM
> can it check that you read the screenshot as well?

### March 27, 5:55 PM
> as before like, please test. can you drag and screenshot yourself dragging?

### March 27, 6:29 PM
> ok. do the assumptions. can you like, either highlight the others in tlda or like, screenshot them?

### March 27, 8:54 PM
> given the frequency with which you do this, perhaps you should write a script that opens tlda in playwright with auth

### April 5, 2:18 AM
> It would also be nice to feel like I don't have to do all this shit that I get asked to do all the fucking time. Like, like you could read the fucking console.

---

## DASHBOARD CLEANUP

### April 5, 4:00 PM
> There is no fleet dashboard. What can we do so that agents shut the fuck up about the non-existent fleet dashboard?

### April 5, 4:01 PM
> Should we have like one repository? Should we fix agents memories? Is there guidance that makes reference to this non-existent thing? It has to come from somewhere.

### April 5, 4:02 PM
> all of it

### April 5, 4:07 PM
> figure it out

### April 5, 4:14 PM
> full cleanup please

### April 5, 4:15 PM
> perhaps the name is bad

---

## SANDBOXED QA / DEEPSEEK

### April 5, 1:13 AM
> So at some point we tried out using deep-seek agents in QA rules. And it was interesting because they're very pushy... maybe they're better at [QA]...

### April 5, 1:16 AM
> ...persistence so whoever we start up is going to think they're doing whatever the last goose agent was doing so we need to figure out... how to provide the right context... I don't entirely trust them not to do harm so we need to figure out how to like box them up... like Docker or whatever.

### April 5, 1:18 AM
> I guess one question is just like why not Docker right if it's like fucking bulletproof... What's the harm in doing that

### April 5, 1:21 AM
> after voice and foot cursor/handsfree stuff but like, easy enough maybe to do simultaneously

---

## TOOLBAR

### March 16, 5:36 PM
> great slider dude. now just add a pointer [or special html pointer if available---the toolbar's top tool] on the bottom and an eraser on the top

### March 27, 4:20 PM
> the refviewer does seem to obstruct the toolbar though

> perhaps, if we're doing the refviewer on the left, the toolbar should go elsewhere

### March 27, 4:22 PM
> I wanted you to move the toolbar

### March 27, 4:31 PM
> like, step one, roll layout back to the version before where both things were on the left. that was tolerable. moving the toolbar is annoying, so maybe the trick is just to put it above chat in the z index

### March 27, 5:34 PM
> we had some smaller scale stuff like matching fleet styling? what else was there? oh, the toolbar z-index thing. still doesn't work

### March 29, 9:04 PM
> like, it should look like the toolbar in its opacity
