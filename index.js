const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
dotenv.config(); // Load .env variables

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.gjrobqi.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB");
    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riderApplications");

    // custom middleware
    const veryFBToken = async (req, res, next) => {
      const authHeaders = req.headers.authorization;
      if (!authHeaders) {
        return res.status(404).send({ message: "unauthorized access" });
      }
      const token = authHeaders.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    app.get("/users/search", async (req, res) => {
      const emailQuery = req.query.email;
      if (!emailQuery) {
        return res.status(400).send({ message: "Missing email query" });
      }

      const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

      try {
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          // .project({ email: 1, createdAt: 1, role: 1 })
          .limit(10)
          .toArray();
        res.send(users);
      } catch (error) {
        console.error("Error searching users", error);
        res.status(500).send({ message: "Error searching users" });
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("Error getting user role:", error);
        res.status(500).send({ message: "Failed to get role" });
      }
    });

    app.patch("/users/:id/role", async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;

      if (!["admin", "user"].includes(role)) {
        return res.status(400).send({ message: "Invalid role" });
      }

      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        res.send({ message: `User role updated to ${role}`, result });
      } catch (error) {
        console.error("Error updating user role", error);
        res.status(500).send({ message: "Failed to update user role" });
      }
    });

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        // update last login
        return res
          .status(200)
          .send({ message: "User already exists", insertedId: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //
    app.get("/parcels", veryFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;

        let query = {};
        if (userEmail) {
          query = { created_by: userEmail };
        }

        const options = {
          sort: { createdAt: -1 }, // Newest first
        };

        const parcels = await parcelCollection.find(query, options).toArray();
        res.json(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).json({ error: "Failed to fetch parcels" });
      }
    });

    // GET: Get a single parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };
        const parcel = await parcelCollection.findOne(query);

        if (!parcel) {
          return res.status(404).json({ error: "Parcel not found" });
        }

        res.json(parcel);
      } catch (error) {
        console.error("Error fetching parcel by ID:", error);
        res.status(500).json({ error: "Failed to retrieve parcel" });
      }
    });

    // post
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        // newParcel.createdAt  = new Data()
        const result = await parcelCollection.insertOne(newParcel);
        res.send(result);
        console.log(newParcel);
      } catch (error) {
        console.error("Error creating parcel:", error);
        res.status(500).json({ error: "Failed to create parcel" });
      }
    });

    //
    app.post("/rider-application", async (req, res) => {
      try {
        const applicationData = req.body;
        const result = await ridersCollection.insertOne(applicationData);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting rider application:", error);
        res.status(500).send({ message: "Failed to submit application" });
      }
    });

    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to get pending riders:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.get("/riders/active", async (req, res) => {
      const result = await ridersCollection
        .find({ status: "active" })
        .toArray();
      res.send(result);
    });

    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status,
        },
      };

      try {
        const result = await ridersCollection.updateOne(query, updateDoc);

        // update user role for accepting rider
        if (status === "active") {
          const userQuery = { email };
          const userUpdateDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await usersCollection.updateOne(
            userQuery,
            userUpdateDoc
          );
          console.log(roleResult.modifiedCount);
        }

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).json({ error: "Failed to delete parcel" });
      }
    });

    app.post("/tracking", async (req, res) => {
      try {
        const { tracking_id, parcel_id, status, message, updated_by } =
          req.body;

        const result = await db.collection("tracking").insertOne({
          parcelId,
          status,
          location,
          remarks,
          updatedBy,
          updatedAt: new Date(),
        });

        res
          .status(201)
          .send({ message: "Tracking update saved", id: result.insertedId });
      } catch (error) {
        console.error("Error inserting tracking:", error);
        res.status(500).send({ message: "Failed to save tracking update" });
      }
    });

    app.get("/payments", veryFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        console.log("decoded", req.decoded);

        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "forbidden access" });
        }

        const query = userEmail ? { email: userEmail } : {};
        const options = {
          sort: { paid_at: -1 }, // Latest payments first
        };

        const payments = await paymentsCollection
          .find(query, options)
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    // POST: Record Payment and update parcel status
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, paymentMethod, transactionId } =
          req.body;

        // 1. Update parcel payment_status
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
            },
          }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already marked as paid." });
        }

        // 2. Insert payment record
        const paymentDoc = {
          parcelId,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.status(201).send({
          message: "Payment recorded and parcel marked as paid.",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Error recording payment:", error);
        res
          .status(500)
          .send({ message: "Server error while recording payment." });
      }
    });

    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      console.log(amountInCents);
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
  res.send("Parcel Delivery Server is running");
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
