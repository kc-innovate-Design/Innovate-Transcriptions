const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();

// Define parameters — these are set via Firebase CLI before deploy
const gmailUser = defineString("GMAIL_USER", {
    description: "Gmail/Workspace email address to send from",
});
const gmailAppPassword = defineString("GMAIL_APP_PASSWORD", {
    description: "Gmail App Password for SMTP authentication",
});

exports.sendEmail = onDocumentCreated("mail/{docId}", async (event) => {
    const snap = event.data;
    if (!snap) {
        console.log("No data in document");
        return;
    }

    const mailData = snap.data();
    const { to, message } = mailData;

    if (!to || !message) {
        console.error("Missing 'to' or 'message' field in mail document:", snap.id);
        await snap.ref.update({
            "delivery.state": "ERROR",
            "delivery.error": "Missing 'to' or 'message' field",
            "delivery.endTime": admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
    }

    // Create transporter with Gmail SMTP
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: gmailUser.value(),
            pass: gmailAppPassword.value(),
        },
    });

    try {
        console.log(`Sending email to: ${to} | Subject: ${message.subject}`);

        await transporter.sendMail({
            from: `"Innovate Transcriptions" <${gmailUser.value()}>`,
            to: to,
            subject: message.subject || "Innovate Transcriptions",
            html: message.html || message.text || "",
        });

        console.log(`Email sent successfully to: ${to}`);

        // Update document with success status
        await snap.ref.update({
            "delivery.state": "SUCCESS",
            "delivery.endTime": admin.firestore.FieldValue.serverTimestamp(),
            "delivery.info": { accepted: [to] },
        });
    } catch (error) {
        console.error(`Failed to send email to ${to}:`, error.message);

        // Update document with error status
        await snap.ref.update({
            "delivery.state": "ERROR",
            "delivery.error": error.message,
            "delivery.endTime": admin.firestore.FieldValue.serverTimestamp(),
        });
    }
});
