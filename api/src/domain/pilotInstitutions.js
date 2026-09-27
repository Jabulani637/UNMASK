'use strict';
/**
 * The five institutions Unmask opens with, as data.
 *
 * This file is a *starting point for the collection*, not a rule. It is the only
 * place in the API where an institution is named, and it exists because a brand
 * new database has nothing in it: the boot gate needs at least one active
 * institution before anybody can register, and a first deployment cannot be
 * bootstrapped by a staff screen nobody can sign in to yet.
 *
 * **Every email domain below except CPUT's is unverified.** CPUT's two come out of
 * the working system. The others are the shapes those institutions use, written
 * down by somebody who could not check them, and a wrong one fails in the safe
 * direction — nobody from that school can register, the site says so plainly, and
 * the request form catches the complaint. Fixing it is one field on one document
 * at `/staff`, in a browser, with no redeploy. That is NFR-SCALE-1 paying for
 * itself, and it is the reason this file says "verify" instead of refusing to
 * launch.
 *
 * `city` is a scoring input, nothing else. v2 §7 lists Stellenbosch as its own
 * city while the paragraph under that table says all five "share the same city
 * tier". The table is the more specific instruction, so it wins here: a
 * Stellenbosch student does not collect the same-city six points against a Cape
 * Town one. If that is the wrong reading, the fix is the string in this file, or
 * the field on the live document — not a change to the engine.
 *
 * `faculties` is filled for CPUT only, because that list is the one this project
 * already had. Every other institution gets an empty list, which the profile form
 * reads as "type your school" rather than as a denial.
 */

const PILOT_INSTITUTIONS = [
  {
    name: 'Cape Peninsula University of Technology',
    shortName: 'CPUT',
    type: 'university',
    city: 'Cape Town',
    emailDomains: ['mycput.ac.za', 'cput.ac.za'],
    faculties: [
      'Engineering',
      'Informatics & Design',
      'Business & Management Sciences',
      'Applied Sciences',
      'Education',
      'Health & Wellness Sciences',
    ],
  },
  {
    name: 'University of Cape Town',
    shortName: 'UCT',
    type: 'university',
    city: 'Cape Town',
    emailDomains: ['my.uct.ac.za', 'uct.ac.za'],
    faculties: [],
  },
  {
    name: 'University of the Western Cape',
    shortName: 'UWC',
    type: 'university',
    city: 'Cape Town',
    emailDomains: ['myuwc.ac.za', 'uwc.ac.za'],
    faculties: [],
  },
  {
    name: 'Stellenbosch University',
    shortName: 'STELLENBOSCH',
    type: 'university',
    city: 'Stellenbosch',
    emailDomains: ['sun.ac.za'],
    faculties: [],
  },
  {
    name: 'Northlink College',
    shortName: 'NORTHLINK',
    type: 'tvet',
    city: 'Cape Town',
    emailDomains: ['northlink.ac.za'],
    faculties: [],
  },
];

module.exports = { PILOT_INSTITUTIONS };
